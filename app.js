const express = require('express');
const mysql = require('mysql2');
const session = require('express-session');
const flash = require('connect-flash');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();

// ============================================================
// Image uploads (room / equipment photos)
// Files are saved under public/uploads/<kind>/ so they're served
// automatically by express.static('public'), and the stored
// image_url is the public path (e.g. /uploads/rooms/rooms-123.jpg).
// ============================================================
function makeUploader(kind) {
    const dir = path.join(__dirname, 'public', 'uploads', kind);
    fs.mkdirSync(dir, { recursive: true });
    const storage = multer.diskStorage({
        destination: (req, file, cb) => cb(null, dir),
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname);
            cb(null, `${kind}-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
        }
    });
    return multer({
        storage,
        limits: { fileSize: 5 * 1024 * 1024 },
        fileFilter: (req, file, cb) => {
            const allowed = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
            if (!allowed.includes(file.mimetype)) {
                return cb(new Error('Only PNG, JPEG, WEBP or GIF images are allowed.'));
            }
            cb(null, true);
        }
    });
}
const uploadRoomImage = makeUploader('rooms');
const uploadEquipmentImage = makeUploader('equipment');

// ============================================================
// Database connection
// ============================================================
const db = mysql.createConnection({
    host: 'c237-hungteng-mysql.mysql.database.azure.com',
    user: 'c237_008',
    password: 'c237008@2026!',
    database: 'c237_008_t3_ca2',
    ssl: {
    rejectUnauthorized: false
}
});

db.connect((err) => {
    if (err) {
        throw err;
    }
    console.log('Connected to database');
});

app.use(express.urlencoded({ extended: false }));
app.use(express.json()); // needed for Fetch API requests (favourites toggle)
app.use(express.static('public'));

app.use(session({
    secret: 'bookwise_secret_key',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 } // 1 week
}));

app.use(flash());
app.set('view engine', 'ejs');

// Make current user available to every view without passing it manually
app.use((req, res, next) => {
    res.locals.currentUser = req.session.user || null;
    next();
});

// ============================================================
// Categories — admin-managed facility groupings (Sports, Study, ...).
// Loaded fresh from the DB on every request so admin changes (add /
// rename / delete a category) show up immediately everywhere, and made
// available to every view as `CATEGORIES`, keyed by slug, without
// passing it manually from each route.
// ============================================================
app.use((req, res, next) => {
    db.query('SELECT * FROM categories ORDER BY label ASC', (err, rows) => {
        if (err) {
            console.error(err);
            rows = [];
        }
        const CATEGORIES = {};
        rows.forEach((c) => {
            CATEGORIES[c.slug] = { label: c.label, icon: c.icon, tagline: c.description || '' };
        });
        res.locals.CATEGORIES = CATEGORIES;
        req.categoryList = rows; // ordered raw rows, handy for the admin management page
        next();
    });
});

// ============================================================
// Middleware
// ============================================================
const checkAuthenticated = (req, res, next) => {
    if (req.session.user) {
        return next();
    }
    req.flash('error', 'Please log in to view this resource');
    res.redirect('/login');
};

const checkAdmin = (req, res, next) => {
    if (req.session.user && req.session.user.role === 'admin') {
        return next();
    }
    req.flash('error', 'Access denied');
    res.redirect('/dashboard');
};

// ============================================================
// Helper: current time as a MySQL DATETIME string, taken from the
// Node app server's clock.
//
// start_time / end_time are stored as plain (timezone-less) values
// straight from the browser's <input type="datetime-local">, i.e.
// the student's local wall-clock time. The Azure MySQL server runs
// in UTC, so comparing those columns against SQL's NOW() (the DB
// server's own clock) was off by the UTC offset — this is what made
// check-in silently fail: NOW() was always several hours "behind"
// the stored start_time, so the checkin window never matched.
// Using the Node server's local time keeps everything on the same
// clock as the values that were stored.
// ============================================================
function nowForSql() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ============================================================
// Helper: keep booking statuses in sync with real time.
// Runs a few lightweight UPDATE queries before we read booking data,
// instead of a cron job (cron / node-schedule are not covered in class).
// ============================================================
function syncBookingStatuses(callback) {
    const expirePending = `
        UPDATE bookings
        SET status = 'expired'
        WHERE status = 'pending' AND created_at < NOW() - INTERVAL 30 MINUTE`;

    const completeCheckedIn = `
        UPDATE bookings
        SET status = 'completed'
        WHERE status = 'checked_in' AND end_time < ?`;

    db.query(expirePending, (err1) => {
        if (err1) return callback(err1);
        db.query(completeCheckedIn, [nowForSql()], (err2) => callback(err2));
    });
}

// ============================================================
// Helpers: shared booking lookups used by the detail and receipt
// pages. Both need the same booking+room+student join and the same
// equipment list, so they're pulled out here instead of being
// duplicated in each route.
// ============================================================

// Fetch a single booking by ID, with room and student info attached.
// No ownership filtering here — callers decide who's allowed to see it.
// Calls back with `null` if the booking doesn't exist.
function fetchBookingById(bookingId, callback) {
    const sql = `
        SELECT b.*, r.room_name, r.location, r.image_url, u.username
        FROM bookings b
        LEFT JOIN rooms r ON b.room_id = r.room_id
        JOIN users u ON b.user_id = u.user_id
        WHERE b.booking_id = ?`;
    db.query(sql, [bookingId], (err, results) => {
        if (err || results.length === 0) return callback(null);
        callback(results[0]);
    });
}

// Fetch the equipment reserved for a booking. Calls back with an empty
// array (instead of erroring) if none is found or the query fails.
function fetchEquipmentForBooking(bookingId, callback) {
    const sql = `
        SELECT e.equipment_name, e.image_url, be.quantity
        FROM booking_equipment be
        JOIN equipment e ON be.equipment_id = e.equipment_id
        WHERE be.booking_id = ?`;
    db.query(sql, [bookingId], (err, equipmentUsed) => {
        if (err) { console.error(err); return callback([]); }
        callback(equipmentUsed);
    });
}

// ============================================================
// Home
// ============================================================
app.get('/', (req, res) => {
    const announcementSql = `SELECT a.*, u.username AS posted_by_name
                 FROM announcements a
                 JOIN users u ON a.posted_by = u.user_id
                 ORDER BY a.created_at DESC LIMIT 3`;
    // Rows with a photo are shown first, so the homepage showcase
    // leads with real images rather than blank cards; rooms without
    // one yet still render (falls back to placeholder.svg on the
    // front end) instead of being hidden.
    const galleryRoomSql = `SELECT room_id, room_name, location, image_url
                 FROM rooms WHERE status = 'active'
                 ORDER BY (image_url IS NULL) ASC, created_at ASC LIMIT 8`;

    db.query(announcementSql, (err, announcements) => {
        if (err) {
            console.error(err);
            announcements = [];
        }
        db.query(galleryRoomSql, (err2, galleryRooms) => {
            if (err2) {
                console.error(err2);
                galleryRooms = [];
            }
            res.render('index', {
                user: req.session.user,
                messages: req.flash('success'),
                announcements,
                galleryRooms
            });
        });
    });
});

// ============================================================
// Register
// ============================================================
app.get('/register', (req, res) => {
    res.render('register', {
        messages: req.flash('error'),
        formData: req.flash('formData')[0]
    });
});

const ADMIN_REGISTRATION_CODE = 'admin123';

const validateRegistration = (req, res, next) => {
    const { username, email, password, confirmPassword, contact, department, role, adminCode } = req.body;
    if (!username || !email || !password || !confirmPassword || !contact || !department || !role) {
        req.flash('error', 'All fields are required.');
        req.flash('formData', req.body);
        return res.redirect('/register');
    }
    if (password.length < 6) {
        req.flash('error', 'Password should be at least 6 characters long');
        req.flash('formData', req.body);
        return res.redirect('/register');
    }
    if (password !== confirmPassword) {
        req.flash('error', 'Passwords do not match.');
        req.flash('formData', req.body);
        return res.redirect('/register');
    }
    if (role === 'admin' && adminCode !== ADMIN_REGISTRATION_CODE) {
        req.flash('error', 'Invalid admin code.');
        req.flash('formData', req.body);
        return res.redirect('/register');
    }
    next();
};

app.post('/register', validateRegistration, (req, res) => {
    const { username, email, password, contact, department, role } = req.body;

    bcrypt.hash(password, 10, (err, hashedPassword) => {
        if (err) {
            console.error(err);
            req.flash('error', 'An error occurred during registration. Please try again.');
            return res.redirect('/register');
        }

        const sql = `INSERT INTO users (username, email, password, contact, department, role)
                     VALUES (?, ?, ?, ?, ?, ?)`;
        db.query(sql, [username, email, hashedPassword, contact, department, role], (err) => {
            if (err) {
                console.error('Registration error:', err);
                req.flash('error', 'An error occurred during registration. Please try again.');
                req.flash('formData', req.body);
                return res.redirect('/register');
            }
            req.flash('success', 'Registration successful! Please log in.');
            res.redirect('/login');
        });
    });
});

// ============================================================
// Login
// ============================================================
app.get('/login', (req, res) => {
    res.render('login', {
        user: req.session.user || null,
        messages: req.flash('success'),
        errors: req.flash('error')
    });
});

app.post('/login', (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        req.flash('error', 'All fields are required.');
        return res.redirect('/login');
    }

    const sql = 'SELECT * FROM users WHERE email = ?';
    db.query(sql, [email], (err, results) => {
        if (err) {
            console.error('Login error:', err);
            req.flash('error', 'An error occurred during login. Please try again.');
            return res.redirect('/login');
        }
        if (results.length === 0) {
            req.flash('error', 'Invalid email or password.');
            return res.redirect('/login');
        }

        const foundUser = results[0];
        bcrypt.compare(password, foundUser.password, (err, match) => {
            if (err) {
                console.error(err);
                req.flash('error', 'An error occurred during login. Please try again.');
                return res.redirect('/login');
            }
            if (!match) {
                req.flash('error', 'Invalid email or password.');
                return res.redirect('/login');
            }
            req.session.user = foundUser;
            res.redirect('/dashboard');
        });
    });
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/');
    });
});

// ============================================================
// Forgot Password
// ============================================================
app.get('/forgot-password', (req, res) => {
    res.render('forgot-password', {
        errors: req.flash('error'),
        messages: req.flash('success')
    });
});

app.post('/forgot-password', (req, res) => {
    const { email, newPassword, confirmPassword } = req.body;

    if (!email || !newPassword || !confirmPassword) {
        req.flash('error', 'Please fill in all fields.');
        return res.redirect('/forgot-password');
    }

    if (newPassword !== confirmPassword) {
        req.flash('error', 'Passwords do not match.');
        return res.redirect('/forgot-password');
    }

    const sql = 'SELECT * FROM users WHERE email = ?';
    db.query(sql, [email], (err, results) => {
        if (err) {
            console.error('Forgot password error:', err);
            req.flash('error', 'An error occurred. Please try again.');
            return res.redirect('/forgot-password');
        }
        if (results.length === 0) {
            req.flash('error', 'No user found with that email address.');
            return res.redirect('/forgot-password');
        }

        bcrypt.hash(newPassword, 10, (err, hashedPassword) => {
            if (err) {
                console.error(err);
                req.flash('error', 'An error occurred. Please try again.');
                return res.redirect('/forgot-password');
            }
            db.query('UPDATE users SET password = ? WHERE email = ?', [hashedPassword, email], (err) => {
                if (err) {
                    console.error(err);
                    req.flash('error', 'An error occurred. Please try again.');
                    return res.redirect('/forgot-password');
                }
                req.flash('success', 'Password reset successful. Please log in with your new password.');
                res.redirect('/login');
            });
        });
    });
});

// ============================================================
// Dashboard ("My Dashboard" - student) / redirect admin
// ============================================================
app.get('/dashboard', checkAuthenticated, (req, res) => {
    if (req.session.user.role === 'admin') {
        return res.redirect('/admin');
    }

    syncBookingStatuses((syncErr) => {
        if (syncErr) console.error(syncErr);

        const userId = req.session.user.user_id;

        const upcomingSql = `
            SELECT b.*, r.room_name, r.image_url FROM bookings b
            LEFT JOIN rooms r ON b.room_id = r.room_id
            WHERE b.user_id = ? AND b.status IN ('approved','checked_in') AND b.start_time > ?
            ORDER BY b.start_time ASC LIMIT 5`;

        const pendingSql = `
            SELECT b.*, r.room_name, r.image_url FROM bookings b
            LEFT JOIN rooms r ON b.room_id = r.room_id
            WHERE b.user_id = ? AND b.status = 'pending'
            ORDER BY b.start_time ASC`;

        const favouritesSql = `
            SELECT r.* FROM favourites f
            JOIN rooms r ON f.room_id = r.room_id
            WHERE f.user_id = ?
            ORDER BY f.created_at DESC LIMIT 5`;

        const recentSql = `
            SELECT r.room_id, r.room_name, r.image_url,
                   MAX(b.booking_id) AS booking_id, MAX(b.start_time) AS last_used
            FROM bookings b
            JOIN rooms r ON b.room_id = r.room_id
            WHERE b.user_id = ? AND b.status IN ('completed','checked_in')
            GROUP BY r.room_id, r.room_name, r.image_url
            ORDER BY last_used DESC LIMIT 5`;

        db.query(upcomingSql, [userId, nowForSql()], (err, upcoming) => {
            if (err) { console.error(err); upcoming = []; }
            db.query(pendingSql, [userId], (err, pending) => {
                if (err) { console.error(err); pending = []; }
                db.query(favouritesSql, [userId], (err, favourites) => {
                    if (err) { console.error(err); favourites = []; }
                    db.query(recentSql, [userId], (err, recent) => {
                        if (err) { console.error(err); recent = []; }
                        const announcementsSql = `
                            SELECT a.*, u.username AS posted_by_name
                            FROM announcements a
                            JOIN users u ON a.posted_by = u.user_id
                            ORDER BY a.created_at DESC LIMIT 3`;
                        db.query(announcementsSql, (err, announcements) => {
                            if (err) { console.error(err); announcements = []; }
                            res.render('dashboard', {
                                user: req.session.user,
                                upcoming, pending, favourites, recent, announcements
                            });
                        });
                    });
                });
            });
        });
    });
});

// ============================================================
// Browse Rooms — Search, Filter, Sort
// ============================================================
app.get('/rooms', checkAuthenticated, (req, res) => {
    const { q, location, sort, category } = req.query;
    const userId = req.session.user.user_id;

    let sql = `
        SELECT r.*, f.user_id AS is_favourite,
            (SELECT COUNT(*) FROM bookings b
                WHERE b.room_id = r.room_id
                  AND b.status IN ('pending','approved','checked_in')
                  AND b.end_time >= ?) AS upcoming_booking_count
        FROM rooms r
        LEFT JOIN favourites f ON r.room_id = f.room_id AND f.user_id = ?
        WHERE 1=1`;
    const params = [nowForSql(), userId];

    if (category) {
        sql += ` AND r.category = ?`;
        params.push(category);
    }
    if (q) {
        sql += ` AND (r.room_name LIKE ? OR r.location LIKE ?)`;
        params.push(`%${q}%`, `%${q}%`);
    }
    if (location) {
        sql += ` AND r.location LIKE ?`;
        params.push(`%${location}%`);
    }

    const sortOptions = {
        name: 'r.room_name ASC',
        capacity_asc: 'r.capacity ASC',
        capacity_desc: 'r.capacity DESC',
        favourites: 'f.user_id IS NULL, r.room_name ASC'
    };
    sql += ` ORDER BY ${sortOptions[sort] || 'r.room_name ASC'}`;

    db.query(sql, params, (err, rooms) => {
        if (err) {
            console.error(err);
            rooms = [];
        }
        res.render('rooms', {
            user: req.session.user,
            rooms,
            query: req.query,
            activeCategory: category || null
        });
    });
});

app.get('/rooms/:id', checkAuthenticated, (req, res) => {
    const roomSql = `SELECT * FROM rooms WHERE room_id = ?`;

    db.query(roomSql, [req.params.id], (err, roomResults) => {
        if (err || roomResults.length === 0) {
            req.flash('error', 'Room not found.');
            return res.redirect('/rooms');
        }
        const room = roomResults[0];
        // Show all equipment for this category (including ones under
        // maintenance) so the student can see what's temporarily
        // unavailable, rather than it just silently disappearing.
        const equipmentSql = `SELECT * FROM equipment WHERE category = ?`;
        db.query(equipmentSql, [room.category], (err, equipmentList) => {
            if (err) { console.error(err); equipmentList = []; }

            // Upcoming slots already taken for this room, so students can
            // see availability before submitting a request that will just
            // get rejected for conflicting with an existing booking.
            const bookedSlotsSql = `
                SELECT start_time, end_time, status FROM bookings
                WHERE room_id = ? AND status IN ('pending','approved','checked_in')
                  AND end_time >= ?
                ORDER BY start_time ASC`;
            db.query(bookedSlotsSql, [room.room_id, nowForSql()], (err, bookedSlots) => {
                if (err) { console.error(err); bookedSlots = []; }
                res.render('room-detail', {
                    user: req.session.user,
                    room,
                    equipmentList,
                    bookedSlots,
                    errors: req.flash('error'),
                    prefill: req.flash('prefill')[0]
                });
            });
        });
    });
});

// ============================================================
// Favourites (Fetch API target — returns JSON, no page reload)
// ============================================================
app.post('/favourites/:roomId/toggle', checkAuthenticated, (req, res) => {
    const userId = req.session.user.user_id;
    const roomId = req.params.roomId;

    const checkSql = `SELECT * FROM favourites WHERE user_id = ? AND room_id = ?`;
    db.query(checkSql, [userId, roomId], (err, results) => {
        if (err) return res.status(500).json({ success: false, message: 'Database error' });

        if (results.length > 0) {
            db.query(`DELETE FROM favourites WHERE user_id = ? AND room_id = ?`, [userId, roomId], (err) => {
                if (err) return res.status(500).json({ success: false, message: 'Database error' });
                res.json({ success: true, favourited: false });
            });
        } else {
            db.query(`INSERT INTO favourites (user_id, room_id) VALUES (?, ?)`, [userId, roomId], (err) => {
                if (err) return res.status(500).json({ success: false, message: 'Database error' });
                res.json({ success: true, favourited: true });
            });
        }
    });
});


// ============================================================
// Booking Creation — with Conflict Detection
// ============================================================
app.post('/bookings', checkAuthenticated, (req, res) => {
    const userId = req.session.user.user_id;
    const { room_id, start_time, end_time, purpose } = req.body;
    let equipmentIds = req.body.equipment_ids || [];
    if (!Array.isArray(equipmentIds)) equipmentIds = [equipmentIds];

    if (!room_id || !start_time || !end_time) {
        req.flash('error', 'Please fill in all required fields.');
        return res.redirect(`/rooms/${room_id}`);
    }
    if (new Date(start_time) >= new Date(end_time)) {
        req.flash('error', 'End time must be after start time.');
        return res.redirect(`/rooms/${room_id}`);
    }
    // No booking a room in the past — the slot must start now or later.
    if (new Date(start_time) < new Date()) {
        req.flash('error', 'You cannot book a time in the past. Please choose the current time or later.');
        return res.redirect(`/rooms/${room_id}`);
    }

    // A room under maintenance (or removed) can't be booked, even via a
    // direct link to an old room page.
    db.query(`SELECT status FROM rooms WHERE room_id = ?`, [room_id], (err, roomResults) => {
        if (err || roomResults.length === 0) {
            req.flash('error', 'Room not found.');
            return res.redirect('/rooms');
        }
        if (roomResults[0].status !== 'active') {
            req.flash('error', 'This room is currently under maintenance and cannot be booked.');
            return res.redirect(`/rooms/${room_id}`);
        }

        // Any equipment selected must also be available, not under maintenance.
        checkEquipmentAndCreateBooking();
    });

    function checkEquipmentAndCreateBooking() {
        if (equipmentIds.length > 0) {
            const equipStatusSql = `SELECT equipment_id, equipment_name FROM equipment WHERE equipment_id IN (?) AND status != 'active'`;
            db.query(equipStatusSql, [equipmentIds], (err, unavailable) => {
                if (err) {
                    console.error(err);
                    req.flash('error', 'An error occurred. Please try again.');
                    return res.redirect(`/rooms/${room_id}`);
                }
                if (unavailable.length > 0) {
                    req.flash('error', `${unavailable.map(e => e.equipment_name).join(', ')} is currently under maintenance and unavailable.`);
                    return res.redirect(`/rooms/${room_id}`);
                }
                createBooking();
            });
        } else {
            createBooking();
        }
    }

    function createBooking() {

    // Conflict detection: overlapping bookings on the same room that are
    // still "live" (pending / approved / checked_in) block the new slot.
    const conflictSql = `
        SELECT * FROM bookings
        WHERE room_id = ?
          AND status IN ('pending','approved','checked_in')
          AND NOT (end_time <= ? OR start_time >= ?)`;

    db.query(conflictSql, [room_id, start_time, end_time], (err, conflicts) => {
        if (err) {
            console.error(err);
            req.flash('error', 'An error occurred. Please try again.');
            return res.redirect(`/rooms/${room_id}`);
        }
        if (conflicts.length > 0) {
            req.flash('error', 'This room is already booked for the selected time. Please choose another slot.');
            return res.redirect(`/rooms/${room_id}`);
        }

        // Facility-only bookings (no equipment requested) are confirmed
        // automatically. Adding equipment still needs an admin to approve
        // the rental, so those bookings stay pending.
        const initialStatus = equipmentIds.length === 0 ? 'approved' : 'pending';

        const insertSql = `
            INSERT INTO bookings (user_id, room_id, start_time, end_time, purpose, status)
            VALUES (?, ?, ?, ?, ?, ?)`;
        db.query(insertSql, [userId, room_id, start_time, end_time, purpose, initialStatus], (err, result) => {
            if (err) {
                console.error(err);
                req.flash('error', 'An error occurred while creating your booking.');
                return res.redirect(`/rooms/${room_id}`);
            }

            const bookingId = result.insertId;
            if (equipmentIds.length === 0) {
                req.flash('success', 'Booking confirmed! Your room is reserved.');
                return res.redirect('/my-bookings');
            }

            const equipSql = `INSERT INTO booking_equipment (booking_id, equipment_id, quantity) VALUES ?`;
            const values = equipmentIds.map((id) => [bookingId, id, 1]);
            db.query(equipSql, [values], (err) => {
                if (err) console.error(err);
                req.flash('success', 'Booking request submitted! Equipment rentals need admin approval before they\'re confirmed.');
                res.redirect('/my-bookings');
            });
        });
    });
    }
});

// ============================================================
// Duplicate Booking — "Book Again"
// ============================================================
app.post('/bookings/:id/duplicate', checkAuthenticated, (req, res) => {
    const userId = req.session.user.user_id;
    const bookingSql = `SELECT * FROM bookings WHERE booking_id = ? AND user_id = ?`;

    db.query(bookingSql, [req.params.id, userId], (err, results) => {
        if (err || results.length === 0) {
            req.flash('error', 'Booking not found.');
            return res.redirect('/my-bookings');
        }
        const original = results[0];

        // Pull the equipment that was on the original booking, but only
        // carry forward items that are still active — equipment that's
        // gone into maintenance (or been removed) since then shouldn't
        // get silently re-requested.
        const equipSql = `
            SELECT e.equipment_id, e.equipment_name, e.status FROM booking_equipment be
            JOIN equipment e ON be.equipment_id = e.equipment_id
            WHERE be.booking_id = ?`;
        db.query(equipSql, [original.booking_id], (err, equipResults) => {
            if (err) {
                console.error(err);
                equipResults = [];
            }
            const available = equipResults.filter((e) => e.status === 'active');
            const unavailable = equipResults.filter((e) => e.status !== 'active');
            const equipmentIds = available.map((e) => e.equipment_id);

            if (unavailable.length > 0) {
                req.flash('error', `${unavailable.map(e => e.equipment_name).join(', ')} ${unavailable.length === 1 ? 'is' : 'are'} under maintenance and wasn't carried over — pick a replacement if you still need it.`);
            }

            // Pre-fill the room's booking form with the same room/purpose/
            // (still-available) equipment; the student still picks a fresh
            // date/time, since the old slot may now be taken.
            req.flash('prefill', { purpose: original.purpose, equipment_ids: equipmentIds });
            res.redirect(`/rooms/${original.room_id}`);
        });
    });
});

// ============================================================
// Booking History ("My Bookings") — Filter by status
// ============================================================
app.get('/my-bookings', checkAuthenticated, (req, res) => {
    syncBookingStatuses((syncErr) => {
        if (syncErr) console.error(syncErr);

        const userId = req.session.user.user_id;
        const { status } = req.query;

        let sql = `
            SELECT b.*, r.room_name, r.image_url FROM bookings b
            LEFT JOIN rooms r ON b.room_id = r.room_id
            WHERE b.user_id = ?`;
        const params = [userId];

        if (status === 'upcoming') {
            sql += ` AND b.status IN ('pending','approved','checked_in')`;
        } else if (status === 'completed') {
            sql += ` AND b.status = 'completed'`;
        } else if (status === 'cancelled') {
            sql += ` AND b.status IN ('cancelled','rejected','expired')`;
        }

        sql += ` ORDER BY b.start_time DESC`;

        db.query(sql, params, (err, bookings) => {
            if (err) { console.error(err); bookings = []; }
            res.render('my-bookings', {
                user: req.session.user,
                bookings,
                activeStatus: status || 'all'
            });
        });
    });
});

// ============================================================
// Booking Detail (includes status timeline)
// ============================================================
app.get('/bookings/:id', checkAuthenticated, (req, res) => {
    fetchBookingById(req.params.id, (booking) => {
        if (!booking) {
            req.flash('error', 'Booking not found.');
            return res.redirect('/my-bookings');
        }
        const isOwner = booking.user_id === req.session.user.user_id;
        const isAdmin = req.session.user.role === 'admin';
        if (!isOwner && !isAdmin) {
            req.flash('error', 'Access denied.');
            return res.redirect('/dashboard');
        }

        fetchEquipmentForBooking(booking.booking_id, (equipmentUsed) => {
            res.render('booking-detail', {
                user: req.session.user,
                booking,
                equipmentUsed,
                messages: req.flash('success'),
                errors: req.flash('error')
            });
        });
    });
});

// ============================================================
// Booking Management — Edit / Cancel / Check-in / Approve
// ============================================================

// Only pending bookings may be edited by the student who owns them.
app.get('/bookings/:id/edit', checkAuthenticated, (req, res) => {
    const sql = `SELECT * FROM bookings WHERE booking_id = ? AND user_id = ?`;
    db.query(sql, [req.params.id, req.session.user.user_id], (err, results) => {
        if (err || results.length === 0) {
            req.flash('error', 'Booking not found.');
            return res.redirect('/my-bookings');
        }
        const booking = results[0];
        if (booking.status !== 'pending') {
            req.flash('error', 'Only pending bookings can be edited.');
            return res.redirect('/my-bookings');
        }
        res.render('edit-booking', {
            user: req.session.user,
            booking,
            errors: req.flash('error')
        });
    });
});

app.post('/bookings/:id/edit', checkAuthenticated, (req, res) => {
    const { start_time, end_time, purpose } = req.body;
    const bookingId = req.params.id;
    const userId = req.session.user.user_id;

    const ownerSql = `SELECT * FROM bookings WHERE booking_id = ? AND user_id = ?`;
    db.query(ownerSql, [bookingId, userId], (err, results) => {
        if (err || results.length === 0) {
            req.flash('error', 'Booking not found.');
            return res.redirect('/my-bookings');
        }
        const booking = results[0];
        if (booking.status !== 'pending') {
            req.flash('error', 'Only pending bookings can be edited.');
            return res.redirect('/my-bookings');
        }
        if (new Date(start_time) >= new Date(end_time)) {
            req.flash('error', 'End time must be after start time.');
            return res.redirect(`/bookings/${bookingId}/edit`);
        }
        if (new Date(start_time) < new Date()) {
            req.flash('error', 'You cannot book a time in the past. Please choose the current time or later.');
            return res.redirect(`/bookings/${bookingId}/edit`);
        }

        const conflictSql = `
            SELECT * FROM bookings
            WHERE room_id = ? AND booking_id != ?
              AND status IN ('pending','approved','checked_in')
              AND NOT (end_time <= ? OR start_time >= ?)`;
        db.query(conflictSql, [booking.room_id, bookingId, start_time, end_time], (err, conflicts) => {
            if (err) {
                console.error(err);
                req.flash('error', 'An error occurred. Please try again.');
                return res.redirect(`/bookings/${bookingId}/edit`);
            }
            if (conflicts.length > 0) {
                req.flash('error', 'This room is already booked for the selected time.');
                return res.redirect(`/bookings/${bookingId}/edit`);
            }

            const updateSql = `UPDATE bookings SET start_time = ?, end_time = ?, purpose = ? WHERE booking_id = ?`;
            db.query(updateSql, [start_time, end_time, purpose, bookingId], (err) => {
                if (err) {
                    console.error(err);
                    req.flash('error', 'An error occurred while updating your booking.');
                    return res.redirect(`/bookings/${bookingId}/edit`);
                }
                req.flash('success', 'Booking updated successfully.');
                res.redirect('/my-bookings');
            });
        });
    });
});

// Cancel — student can cancel their own booking any time before it starts.
app.post('/bookings/:id/cancel', checkAuthenticated, (req, res) => {
    const sql = `
        UPDATE bookings SET status = 'cancelled'
        WHERE booking_id = ? AND user_id = ?
          AND status IN ('pending','approved')`;
    db.query(sql, [req.params.id, req.session.user.user_id], (err, result) => {
        if (err) {
            console.error(err);
            req.flash('error', 'An error occurred while cancelling your booking.');
        } else if (result.affectedRows === 0) {
            req.flash('error', 'This booking cannot be cancelled.');
        } else {
            req.flash('success', 'Booking cancelled.');
        }
        res.redirect('/my-bookings');
    });
});

// Check-in — student confirms arrival, only within a 15-minute-early
// to end-time window, and only once approved. Students can only
// check in their own booking; admins can no longer check in on a
// student's behalf.
app.post('/bookings/:id/checkin', checkAuthenticated, (req, res) => {
    const now = nowForSql();

    const sql = `UPDATE bookings
           SET status = 'checked_in', checked_in_at = ?
           WHERE booking_id = ? AND user_id = ? AND status = 'approved'
             AND ? BETWEEN (start_time - INTERVAL 15 MINUTE) AND end_time`;
    const params = [now, req.params.id, req.session.user.user_id, now];

    db.query(sql, params, (err, result) => {
        if (err) {
            console.error(err);
            req.flash('error', 'An error occurred while checking in.');
        } else if (result.affectedRows === 0) {
            req.flash('error', 'Check-in is only available close to the booking start time.');
        } else {
            req.flash('success', 'Checked in successfully. Enjoy your session!');
        }
        res.redirect(`/bookings/${req.params.id}`);
    });
});

// Printable receipt — only once approved or beyond. Owners can view
// their own booking's receipt; admins can view any booking's receipt.
app.get('/bookings/:id/receipt', checkAuthenticated, (req, res) => {
    const isAdmin = req.session.user.role === 'admin';
    fetchBookingById(req.params.id, (booking) => {
        const isOwner = booking && booking.user_id === req.session.user.user_id;
        if (!booking || (!isOwner && !isAdmin)) {
            req.flash('error', 'Booking not found.');
            return res.redirect(isAdmin ? '/admin/bookings' : '/my-bookings');
        }
        if (!['approved', 'checked_in', 'completed'].includes(booking.status)) {
            req.flash('error', 'Receipt is only available for approved bookings.');
            return res.redirect(isAdmin ? '/admin/bookings' : '/my-bookings');
        }

        fetchEquipmentForBooking(booking.booking_id, (equipmentUsed) => {
            res.render('booking-receipt', { user: req.session.user, booking, equipmentUsed });
        });
    });
});

// ============================================================
// ADMIN — Category Management
// Categories are no longer a fixed list — admins can create, rename,
// and delete their own facility groupings here.
// ============================================================
function isValidSlug(slug) {
    return /^[a-z0-9_]{2,30}$/.test(slug || '');
}

// NOTE: category management now lives on the "Categories" tab of
// /admin/facilities (admin-facilities.ejs) — there is no standalone
// admin-categories view. Any redirect below that used to point at
// GET /admin/categories has been changed to /admin/facilities?tab=categories
// so it doesn't crash trying to render a view that doesn't exist.

app.post('/admin/categories', checkAuthenticated, checkAdmin, (req, res) => {
    let { slug, label, icon, description } = req.body;
    slug = (slug || '').trim().toLowerCase().replace(/\s+/g, '_');
    if (!isValidSlug(slug) || !label) {
        return res.json({
            success: false,
            message: 'Category key must be lowercase letters, numbers or underscores (2-30 chars), and a label is required.'
        });
    }
    const sql = `INSERT INTO categories (slug, label, icon, description) VALUES (?, ?, ?, ?)`;
    db.query(sql, [slug, label, icon || '📁', description || null], (err) => {
        if (err) {
            console.error(err);
            return res.json({
                success: false,
                message: err.code === 'ER_DUP_ENTRY' ? 'That category key already exists.' : 'Could not create category.'
            });
        }

        // Post an announcement so everyone sees the new category on the
        // home page and their dashboard, in addition to the admin popup.
        const announcementSql = `INSERT INTO announcements (title, message, posted_by) VALUES (?, ?, ?)`;
        const title = 'New category added';
        const message = `${icon || '📁'} "${label}" is now available as a category when booking rooms and equipment.`;
        db.query(announcementSql, [title, message, req.session.user.user_id], (announceErr) => {
            if (announceErr) console.error(announceErr);
            res.json({ success: true, message: `Category "${label}" has been added.` });
        });
    });
});

app.post('/admin/categories/:slug/edit', checkAuthenticated, checkAdmin, (req, res) => {
    const { label, icon, description } = req.body;
    if (!label) {
        req.flash('error', 'Label is required.');
        return res.redirect('/admin/facilities?tab=categories');
    }
    const sql = `UPDATE categories SET label = ?, icon = ?, description = ? WHERE slug = ?`;
    db.query(sql, [label, icon || '📁', description || null, req.params.slug], (err) => {
        if (err) console.error(err);
        req.flash('success', 'Category updated.');
        res.redirect('/admin/facilities?tab=categories');
    });
});

app.post('/admin/categories/:slug/delete', checkAuthenticated, checkAdmin, (req, res) => {
    const checkSql = `
        SELECT
            (SELECT COUNT(*) FROM rooms WHERE category = ?) +
            (SELECT COUNT(*) FROM equipment WHERE category = ?) AS in_use`;
    db.query(checkSql, [req.params.slug, req.params.slug], (err, results) => {
        if (err) {
            console.error(err);
            req.flash('error', 'Could not delete category.');
            return res.redirect('/admin/facilities?tab=categories');
        }
        if (results[0].in_use > 0) {
            req.flash('error', 'This category is still used by rooms or equipment — reassign them first.');
            return res.redirect('/admin/facilities?tab=categories');
        }
        db.query(`DELETE FROM categories WHERE slug = ?`, [req.params.slug], (err) => {
            if (err) console.error(err);
            req.flash('success', 'Category deleted.');
            res.redirect('/admin/facilities?tab=categories');
        });
    });
});

// ============================================================
// ADMIN — Room Management
// ============================================================
app.get('/admin', checkAuthenticated, checkAdmin, (req, res) => {
    syncBookingStatuses((syncErr) => {
        if (syncErr) console.error(syncErr);

        const pendingSql = `SELECT COUNT(*) AS count FROM bookings WHERE status = 'pending'`;
        const roomsSql = `SELECT COUNT(*) AS count FROM rooms WHERE status = 'active'`;
        const bookingsTodaySql = `SELECT COUNT(*) AS count FROM bookings WHERE DATE(start_time) = CURDATE()`;
        const announcementsSql = `
            SELECT a.*, u.username AS posted_by_name
            FROM announcements a
            JOIN users u ON a.posted_by = u.user_id
            ORDER BY a.created_at DESC LIMIT 3`;

        db.query(pendingSql, (err, pendingResult) => {
            db.query(roomsSql, (err2, roomsResult) => {
                db.query(bookingsTodaySql, (err3, todayResult) => {
                    db.query(announcementsSql, (err4, announcements) => {
                        if (err4) { console.error(err4); announcements = []; }
                        res.render('admin', {
                            user: req.session.user,
                            pendingCount: pendingResult ? pendingResult[0].count : 0,
                            activeRooms: roomsResult ? roomsResult[0].count : 0,
                            bookingsToday: todayResult ? todayResult[0].count : 0,
                            announcements
                        });
                    });
                });
            });
        });
    });
});

app.get('/admin/facilities', checkAuthenticated, checkAdmin, (req, res) => {
    // Rooms tab: room_q / room_category / room_status / room_sort
    const { room_q, room_category, room_status, room_sort, eq_q, eq_category, eq_status, eq_sort } = req.query;

    let roomsSql = `
        SELECT r.*,
            (SELECT COUNT(*) FROM bookings b
                WHERE b.room_id = r.room_id
                  AND b.status IN ('pending','approved','checked_in')
                  AND b.end_time >= ?) AS upcoming_booking_count
        FROM rooms r WHERE 1=1`;
    const roomParams = [nowForSql()];
    if (room_q) {
        roomsSql += ` AND (r.room_name LIKE ? OR r.location LIKE ?)`;
        roomParams.push(`%${room_q}%`, `%${room_q}%`);
    }
    if (room_category) {
        roomsSql += ` AND r.category = ?`;
        roomParams.push(room_category);
    }
    if (room_status) {
        roomsSql += ` AND r.status = ?`;
        roomParams.push(room_status);
    }
    const roomSortOptions = {
        name: 'r.room_name ASC',
        capacity_asc: 'r.capacity ASC',
        capacity_desc: 'r.capacity DESC',
        newest: 'r.created_at DESC'
    };
    roomsSql += ` ORDER BY ${roomSortOptions[room_sort] || 'r.room_name ASC'}`;

    db.query(roomsSql, roomParams, (err, rooms) => {
        if (err) {
            console.error(err);
            rooms = [];
        }

        let equipmentSql = `SELECT * FROM equipment WHERE 1=1`;
        const eqParams = [];
        if (eq_q) {
            equipmentSql += ` AND (equipment_name LIKE ? OR description LIKE ?)`;
            eqParams.push(`%${eq_q}%`, `%${eq_q}%`);
        }
        if (eq_category) {
            equipmentSql += ` AND category = ?`;
            eqParams.push(eq_category);
        }
        if (eq_status) {
            equipmentSql += ` AND status = ?`;
            eqParams.push(eq_status);
        }
        const eqSortOptions = {
            name: 'equipment_name ASC',
            quantity_asc: 'quantity_available ASC',
            quantity_desc: 'quantity_available DESC',
            newest: 'created_at DESC'
        };
        equipmentSql += ` ORDER BY ${eqSortOptions[eq_sort] || 'equipment_name ASC'}`;

        db.query(equipmentSql, eqParams, (err, equipment) => {
            if (err) {
                console.error(err);
                equipment = [];
            }

            db.query(`SELECT (SELECT COUNT(*) FROM rooms) AS rooms_total, (SELECT COUNT(*) FROM equipment) AS equipment_total`, (err, totalsResult) => {
                const totals = (!err && totalsResult[0]) ? totalsResult[0] : { rooms_total: rooms.length, equipment_total: equipment.length };

                const categoriesSql = `
                    SELECT c.*,
                        (SELECT COUNT(*) FROM rooms r WHERE r.category = c.slug) AS room_count,
                        (SELECT COUNT(*) FROM equipment e WHERE e.category = c.slug) AS equipment_count
                    FROM categories c
                    ORDER BY c.label ASC`;
                db.query(categoriesSql, (err, categories) => {
                    if (err) {
                        console.error(err);
                        categories = [];
                    }

                    res.render('admin-facilities', {
                        user: req.session.user,
                        rooms,
                        equipment,
                        categories,
                        roomsTotal: totals.rooms_total,
                        equipmentTotal: totals.equipment_total,
                        activeTab: req.query.tab || 'rooms',
                        query: req.query,
                        messages: req.flash('success'),
                        errors: req.flash('error')
                    });
                });
            });
        });
    });
});

// Maintenance Mode toggle — auto-posts maintenance or reopened announcement
app.post('/admin/rooms/:id/toggle-maintenance', checkAuthenticated, checkAdmin, (req, res) => {
    db.query(`SELECT room_name, status FROM rooms WHERE room_id = ?`, [req.params.id], (err, rows) => {
        if (err || rows.length === 0) {
            req.flash('error', 'Could not find room.');
            return res.redirect('/admin/facilities?tab=rooms');
        }

        const room = rows[0];
        const newStatus = room.status === 'active' ? 'maintenance' : 'active';

        db.query(`UPDATE rooms SET status = ? WHERE room_id = ?`, [newStatus, req.params.id], (err) => {
            if (err) {
                console.error(err);
                req.flash('error', 'Could not update room status.');
            } else {
                req.flash('success', `Room status updated to ${newStatus}.`);

                // Post custom announcement depending on status
                const title = newStatus === 'maintenance' 
                    ? `Notice: ${room.room_name} under maintenance` 
                    : `Update: ${room.room_name} is now available`;

                const message = newStatus === 'maintenance'
                    ? `${room.room_name} is currently under maintenance and temporarily unavailable for bookings.`
                    : `${room.room_name} has completed maintenance and is now available for student bookings!`;

                db.query(
                    `INSERT INTO announcements (title, message, posted_by) VALUES (?, ?, ?)`,
                    [title, message, req.session.user.user_id],
                    (announceErr) => {
                        if (announceErr) console.error('Failed to post announcement:', announceErr);
                    }
                );
            }
            res.redirect('/admin/facilities?tab=rooms');
        });
    });
});

// A facility can't have a zero or negative capacity.
function isValidCapacity(capacity) {
    const n = Number(capacity);
    return Number.isInteger(n) && n > 0;
}

app.post('/admin/rooms', checkAuthenticated, checkAdmin, uploadRoomImage.single('image'), (req, res) => {
    const { room_name, location, capacity, description, category } = req.body;
    if (!isValidCapacity(capacity)) {
        req.flash('error', 'Capacity must be a whole number greater than 0.');
        return res.redirect('/admin/facilities?tab=rooms');
    }
    const image_url = req.file ? `/uploads/rooms/${req.file.filename}` : null;
    const sql = `INSERT INTO rooms (room_name, location, capacity, description, category, image_url) VALUES (?, ?, ?, ?, ?, ?)`;
    db.query(sql, [room_name, location, capacity, description, category || 'study', image_url], (err) => {
        if (err) {
            console.error(err);
            req.flash('error', 'Could not add room. Please try again.');
        } else {
            req.flash('success', 'Room added.');
        }
        res.redirect('/admin/facilities?tab=rooms');
    });
});

app.post('/admin/rooms/:id/edit', checkAuthenticated, checkAdmin, uploadRoomImage.single('image'), (req, res) => {
    const { room_name, location, capacity, description, category } = req.body;
    if (!isValidCapacity(capacity)) {
        req.flash('error', 'Capacity must be a whole number greater than 0.');
        return res.redirect('/admin/facilities?tab=rooms');
    }
    // Only overwrite the photo if a new one was actually uploaded —
    // otherwise keep whatever image_url the room already had.
    const sql = req.file
        ? `UPDATE rooms SET room_name = ?, location = ?, capacity = ?, description = ?, category = ?, image_url = ? WHERE room_id = ?`
        : `UPDATE rooms SET room_name = ?, location = ?, capacity = ?, description = ?, category = ? WHERE room_id = ?`;
    const params = req.file
        ? [room_name, location, capacity, description, category || 'study', `/uploads/rooms/${req.file.filename}`, req.params.id]
        : [room_name, location, capacity, description, category || 'study', req.params.id];
    db.query(sql, params, (err) => {
        if (err) {
            console.error(err);
            req.flash('error', 'Could not update room. Please try again.');
        } else {
            req.flash('success', 'Room updated.');
        }
        res.redirect('/admin/facilities?tab=rooms');
    });
});

// Maintenance Mode toggle — disabled rooms cannot be booked (see /rooms query: WHERE status='active')
app.post('/admin/rooms/:id/toggle-maintenance', checkAuthenticated, checkAdmin, (req, res) => {
    const sql = `
        UPDATE rooms
        SET status = IF(status = 'active', 'maintenance', 'active')
        WHERE room_id = ?`;
    db.query(sql, [req.params.id], (err) => {
        if (err) {
            console.error(err);
            req.flash('error', 'Could not update room status.');
        } else {
            req.flash('success', 'Room status updated.');
        }
        res.redirect('/admin/facilities?tab=rooms');
    });
});

app.post('/admin/rooms/:id/delete', checkAuthenticated, checkAdmin, (req, res) => {
    db.query(`DELETE FROM rooms WHERE room_id = ?`, [req.params.id], (err) => {
        if (err) {
            console.error(err);
            req.flash('error', 'Could not delete room. It may still have bookings tied to it.');
        } else {
            req.flash('success', 'Room deleted.');
        }
        res.redirect('/admin/facilities?tab=rooms');
    });
});

// ============================================================
// ADMIN — Equipment Management
// (managed from the Equipment tab on /admin/facilities; there is
// no separate /admin/equipment page)
// ============================================================
app.post('/admin/equipment', checkAuthenticated, checkAdmin, uploadEquipmentImage.single('image'), (req, res) => {
    const { equipment_name, description, quantity_available, category } = req.body;
    const image_url = req.file ? `/uploads/equipment/${req.file.filename}` : null;
    const sql = `INSERT INTO equipment (equipment_name, description, quantity_available, category, image_url) VALUES (?, ?, ?, ?, ?)`;
    db.query(sql, [equipment_name, description, quantity_available, category || 'study', image_url], (err) => {
        if (err) {
            console.error(err);
            req.flash('error', 'Could not add equipment. Please try again.');
        } else {
            req.flash('success', 'Equipment added.');
        }
        res.redirect('/admin/facilities?tab=equipment');
    });
});

app.post('/admin/equipment/:id/edit', checkAuthenticated, checkAdmin, uploadEquipmentImage.single('image'), (req, res) => {
    const { equipment_name, description, quantity_available, category } = req.body;
    const sql = req.file
        ? `UPDATE equipment SET equipment_name = ?, description = ?, quantity_available = ?, category = ?, image_url = ? WHERE equipment_id = ?`
        : `UPDATE equipment SET equipment_name = ?, description = ?, quantity_available = ?, category = ? WHERE equipment_id = ?`;
    const params = req.file
        ? [equipment_name, description, quantity_available, category || 'study', `/uploads/equipment/${req.file.filename}`, req.params.id]
        : [equipment_name, description, quantity_available, category || 'study', req.params.id];
    db.query(sql, params, (err) => {
        if (err) {
            console.error(err);
            req.flash('error', 'Could not update equipment. Please try again.');
        } else {
            req.flash('success', 'Equipment updated.');
        }
        res.redirect('/admin/facilities?tab=equipment');
    });
});

app.post('/admin/equipment/:id/toggle-maintenance', checkAuthenticated, checkAdmin, (req, res) => {
    const sql = `
        UPDATE equipment
        SET status = IF(status = 'active', 'maintenance', 'active')
        WHERE equipment_id = ?`;
    db.query(sql, [req.params.id], (err) => {
        if (err) {
            console.error(err);
            req.flash('error', 'Could not update equipment status.');
        } else {
            req.flash('success', 'Equipment status updated.');
        }
        res.redirect('/admin/facilities?tab=equipment');
    });
});

app.post('/admin/equipment/:id/delete', checkAuthenticated, checkAdmin, (req, res) => {
    db.query(`DELETE FROM equipment WHERE equipment_id = ?`, [req.params.id], (err) => {
        if (err) {
            console.error(err);
            req.flash('error', 'Could not delete equipment. It may still be attached to bookings.');
        } else {
            req.flash('success', 'Equipment deleted.');
        }
        res.redirect('/admin/facilities?tab=equipment');
    });
});

// ============================================================
// ADMIN — Booking Approval Workflow
// ============================================================
app.get('/admin/bookings', checkAuthenticated, checkAdmin, (req, res) => {
    syncBookingStatuses((syncErr) => {
        if (syncErr) console.error(syncErr);

        const { status } = req.query;
        let sql = `
            SELECT b.*, r.room_name, r.image_url, u.username
            FROM bookings b
            LEFT JOIN rooms r ON b.room_id = r.room_id
            JOIN users u ON b.user_id = u.user_id`;
        const params = [];
        if (status) {
            sql += ` WHERE b.status = ?`;
            params.push(status);
        }
        sql += ` ORDER BY b.created_at DESC`;

        db.query(sql, params, (err, bookings) => {
            if (err) { console.error(err); bookings = []; }
            res.render('admin-bookings', {
                user: req.session.user,
                bookings,
                activeStatus: status || 'all'
            });
        });
    });
});

app.post('/admin/bookings/:id/approve', checkAuthenticated, checkAdmin, (req, res) => {
    const sql = `UPDATE bookings SET status = 'approved', admin_remark = ? WHERE booking_id = ? AND status = 'pending'`;
    db.query(sql, [req.body.remark || null, req.params.id], (err) => {
        if (err) console.error(err);
        req.flash('success', 'Booking approved.');
        res.redirect('/admin/bookings');
    });
});

app.post('/admin/bookings/:id/reject', checkAuthenticated, checkAdmin, (req, res) => {
    const sql = `UPDATE bookings SET status = 'rejected', admin_remark = ? WHERE booking_id = ? AND status = 'pending'`;
    db.query(sql, [req.body.remark || 'Rejected by admin', req.params.id], (err) => {
        if (err) console.error(err);
        req.flash('success', 'Booking rejected.');
        res.redirect('/admin/bookings');
    });
});

// ============================================================
// ADMIN — Announcements
// ============================================================
app.get('/admin/announcements', checkAuthenticated, checkAdmin, (req, res) => {
    const sql = `
        SELECT a.*, u.username FROM announcements a
        JOIN users u ON a.posted_by = u.user_id
        ORDER BY a.created_at DESC`;
    db.query(sql, (err, announcements) => {
        if (err) { console.error(err); announcements = []; }
        res.render('admin-announcements', { user: req.session.user, announcements, messages: req.flash('success') });
    });
});

app.post('/admin/announcements', checkAuthenticated, checkAdmin, (req, res) => {
    const { title, message } = req.body;
    const sql = `INSERT INTO announcements (title, message, posted_by) VALUES (?, ?, ?)`;
    db.query(sql, [title, message, req.session.user.user_id], (err) => {
        if (err) console.error(err);
        req.flash('success', 'Announcement posted.');
        res.redirect('/admin/announcements');
    });
});

app.post('/admin/announcements/:id/delete', checkAuthenticated, checkAdmin, (req, res) => {
    db.query(`DELETE FROM announcements WHERE announcement_id = ?`, [req.params.id], (err) => {
        if (err) console.error(err);
        req.flash('success', 'Announcement deleted.');
        res.redirect('/admin/announcements');
    });
});

// ============================================================
// ADMIN — Analytics
// ============================================================
app.get('/admin/analytics', checkAuthenticated, checkAdmin, (req, res) => {
    const popularEquipmentSql = `
        SELECT e.equipment_name, COUNT(*) AS times_booked
        FROM booking_equipment be
        JOIN equipment e ON be.equipment_id = e.equipment_id
        GROUP BY e.equipment_id, e.equipment_name
        ORDER BY times_booked DESC LIMIT 5`;

    const monthlyStatsSql = `
        SELECT DATE_FORMAT(start_time, '%Y-%m') AS month, COUNT(*) AS total_bookings
        FROM bookings
        GROUP BY month
        ORDER BY month DESC LIMIT 6`;

    const peakHoursSql = `
        SELECT HOUR(start_time) AS hour_of_day, COUNT(*) AS total_bookings
        FROM bookings
        GROUP BY hour_of_day
        ORDER BY total_bookings DESC LIMIT 5`;

    const departmentUsageSql = `
        SELECT u.department, COUNT(*) AS total_bookings
        FROM bookings b
        JOIN users u ON b.user_id = u.user_id
        WHERE u.department IS NOT NULL
        GROUP BY u.department
        ORDER BY total_bookings DESC`;

    const approvalRateSql = `
        SELECT
            SUM(CASE WHEN status IN ('approved','checked_in','completed') THEN 1 ELSE 0 END) AS approved_count,
            COUNT(*) AS total_count
        FROM bookings
        WHERE status != 'pending'`;

    db.query(popularEquipmentSql, (err, popularEquipment) => {
        if (err) { console.error(err); popularEquipment = []; }
        db.query(monthlyStatsSql, (err, monthlyStats) => {
            if (err) { console.error(err); monthlyStats = []; }
            db.query(peakHoursSql, (err, peakHours) => {
                if (err) { console.error(err); peakHours = []; }
                db.query(departmentUsageSql, (err, departmentUsage) => {
                    if (err) { console.error(err); departmentUsage = []; }
                    db.query(approvalRateSql, (err, approvalResult) => {
                        if (err) { console.error(err); approvalResult = [{ approved_count: 0, total_count: 0 }]; }
                        const row = approvalResult[0];
                        const approvalRate = row.total_count > 0
                            ? ((row.approved_count / row.total_count) * 100).toFixed(1)
                            : 'N/A';

                        res.render('admin-analytics', {
                            user: req.session.user,
                            popularEquipment,
                            monthlyStats,
                            peakHours,
                            departmentUsage,
                            approvalRate
                        });
                    });
                });
            });
        });
    });
});

// ============================================================
// Error handling — catches multer upload errors (bad file type,
// file too large) so they show up as a normal flash message
// instead of an unhandled crash/500 page.
// ============================================================
app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError || (err && /image/i.test(err.message))) {
        console.error(err);
        req.flash('error', err.code === 'LIMIT_FILE_SIZE' ? 'Image is too large (max 5MB).' : err.message);
        const back = req.get('Referer') || '/admin/facilities';
        return res.redirect(back);
    }
    next(err);
});

// ============================================================
// Start server
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
});


