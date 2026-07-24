-- ============================================================
-- BookWise Database Schema
-- Campus Study Space & Equipment Booking System
-- C237 Software Application Development - CA2
-- ============================================================

DROP TABLE IF EXISTS booking_equipment;
DROP TABLE IF EXISTS favourites;
DROP TABLE IF EXISTS announcements;
DROP TABLE IF EXISTS bookings;
DROP TABLE IF EXISTS equipment;
DROP TABLE IF EXISTS rooms;
DROP TABLE IF EXISTS categories;
DROP TABLE IF EXISTS users;

-- ============================================================
-- USERS
-- ============================================================
CREATE TABLE users (
    user_id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(50) NOT NULL UNIQUE,
    email VARCHAR(100) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL,          -- bcrypt hash
    contact VARCHAR(20),
    department VARCHAR(100),
    role ENUM('student','admin') NOT NULL DEFAULT 'student',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- CATEGORIES (admin-managed facility groupings — e.g. Sports, Study...)
-- ============================================================
CREATE TABLE categories (
    slug VARCHAR(30) PRIMARY KEY,             -- url/code-friendly key, e.g. 'sports'
    label VARCHAR(50) NOT NULL,               -- display name, e.g. 'Sports'
    icon VARCHAR(10) NOT NULL DEFAULT '📁',   -- emoji shown in nav/badges
    description VARCHAR(150),                 -- short tagline shown on the homepage
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- ROOMS
-- ============================================================
CREATE TABLE rooms (
    room_id INT AUTO_INCREMENT PRIMARY KEY,
    room_name VARCHAR(50) NOT NULL,
    location VARCHAR(100),
    capacity INT NOT NULL CHECK (capacity > 0),
    description TEXT,
    image_url VARCHAR(255),
    category VARCHAR(30) NOT NULL DEFAULT 'study',
    status ENUM('active','maintenance') NOT NULL DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (category) REFERENCES categories(slug) ON UPDATE CASCADE
);

-- ============================================================
-- EQUIPMENT
-- ============================================================
CREATE TABLE equipment (
    equipment_id INT AUTO_INCREMENT PRIMARY KEY,
    equipment_name VARCHAR(50) NOT NULL,
    description TEXT,
    quantity_available INT NOT NULL DEFAULT 1,
    image_url VARCHAR(255),
    category VARCHAR(30) NOT NULL DEFAULT 'study',
    status ENUM('active','maintenance') NOT NULL DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (category) REFERENCES categories(slug) ON UPDATE CASCADE
);

-- ============================================================
-- BOOKINGS (spine of the app)
-- ============================================================
CREATE TABLE bookings (
    booking_id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    room_id INT NULL,
    start_time DATETIME NOT NULL,
    end_time DATETIME NOT NULL,
    purpose VARCHAR(255),
    status ENUM(
        'pending','approved','checked_in',
        'completed','cancelled','rejected','expired'
    ) NOT NULL DEFAULT 'pending',
    admin_remark VARCHAR(255),
    checked_in_at DATETIME NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
    FOREIGN KEY (room_id) REFERENCES rooms(room_id) ON DELETE SET NULL
);

-- ============================================================
-- BOOKING_EQUIPMENT (many-to-many junction: booking <-> equipment)
-- ============================================================
CREATE TABLE booking_equipment (
    booking_id INT NOT NULL,
    equipment_id INT NOT NULL,
    quantity INT NOT NULL DEFAULT 1,
    PRIMARY KEY (booking_id, equipment_id),
    FOREIGN KEY (booking_id) REFERENCES bookings(booking_id) ON DELETE CASCADE,
    FOREIGN KEY (equipment_id) REFERENCES equipment(equipment_id) ON DELETE CASCADE
);

-- ============================================================
-- FAVOURITES (many-to-many junction: users <-> rooms)
-- ============================================================
CREATE TABLE favourites (
    user_id INT NOT NULL,
    room_id INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, room_id),
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
    FOREIGN KEY (room_id) REFERENCES rooms(room_id) ON DELETE CASCADE
);

-- ============================================================
-- ANNOUNCEMENTS (admin-posted campus notices)
-- ============================================================
CREATE TABLE announcements (
    announcement_id INT AUTO_INCREMENT PRIMARY KEY,
    title VARCHAR(100) NOT NULL,
    message TEXT NOT NULL,
    posted_by INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (posted_by) REFERENCES users(user_id) ON DELETE CASCADE
);

-- ============================================================
-- MIGRATION NOTE (existing databases only)
-- If you already have a `bookwise` database and don't want to drop it,
-- skip the DROP/CREATE above and just run this instead:
--   ALTER TABLE equipment ADD COLUMN image_url VARCHAR(255) AFTER quantity_available;
-- (rooms.image_url already existed in earlier versions of this schema)
-- ============================================================

-- ============================================================
-- SEED DATA
-- ============================================================

-- Admin password = "admin123", Student password = "student123"
-- (Replace these hashes by just registering through the app - bcrypt salts
--  are random each time, so these are placeholders for reference only.
--  Easiest: leave users table empty and register fresh accounts via /register)

INSERT INTO categories (slug, label, icon, description) VALUES
('sports', 'Sports', '🏀', 'Halls, courts & gear for match day'),
('study', 'Study', '📚', 'Quiet rooms & discussion spaces'),
('computer_lab', 'Computer Labs', '💻', 'Workstations for labs & coding'),
('media_av', 'Media & AV', '🎬', 'Studios, cameras & recording gear');

INSERT INTO rooms (room_name, location, capacity, description, image_url, category, status) VALUES
-- Study
('Discussion Room A', 'Level 2, Library', 6, 'Quiet discussion room with whiteboard', '/images/seed/Discussion_Room.jpg', 'study', 'active'),
('Discussion Room B', 'Level 2, Library', 4, 'Small group room with monitor', '/images/seed/Discussion_Room.jpg', 'study', 'active'),
('Project Lab 1', 'Level 3, Block C', 10, 'Open project space with movable furniture', '/images/seed/Makerspace.jpg', 'study', 'active'),
('Meeting Pod 1', 'Level 1, Student Hub', 2, 'Compact pod for pair work / calls', '/images/seed/Study_Pod.jpg', 'study', 'active'),
('Library Reading Room', 'Level 2, Library', 40, 'Quiet reading & discussion area', '/images/seed/Library.jpg', 'study', 'active'),
('Seminar Room 5', 'Level 4, Block A', 20, 'Larger room for group presentations', '/images/seed/Lecture_Theatre.jpg', 'study', 'maintenance'),
-- Sports
('Sports Hall 1', 'Level 1, Sports Complex', 30, 'Multi-purpose hall for badminton, basketball and volleyball', NULL, 'sports', 'active'),
('Tennis Court A', 'Outdoor Courts, Block F', 4, 'Outdoor hard-court, floodlit for evening play', NULL, 'sports', 'active'),
('Fitness Studio', 'Level 2, Sports Complex', 15, 'Mirrored studio for group fitness and dance practice', NULL, 'sports', 'active'),
-- Computer Labs
('Computer Lab 1', 'Level 3, Block B', 25, 'Windows lab with dev tools and dual monitors', '/images/seed/Computer_Lab.jpg', 'computer_lab', 'active'),
('Computer Lab 2', 'Level 3, Block B', 25, 'Mac lab for design and media coursework', '/images/seed/Computer_Lab.jpg', 'computer_lab', 'active'),
('Coding Sandbox Room', 'Level 4, Block B', 8, 'Small lab for hackathons and pair programming', '/images/seed/Science_Lab.jpg', 'computer_lab', 'active'),
-- Media & AV
('Media Studio 1', 'Level 1, Media Centre', 8, 'Green-screen studio with lighting rig', '/images/seed/Studio_Light.jpg', 'media_av', 'active'),
('Recording Booth', 'Level 1, Media Centre', 2, 'Soundproof booth for voice-overs and podcasts', '/images/seed/Microphone.jpg', 'media_av', 'active'),
('Screening Room', 'Level 2, Media Centre', 18, 'Tiered seating with cinema-grade projector and sound', '/images/seed/Lecture_Theatre.jpg', 'media_av', 'active');

INSERT INTO equipment (equipment_name, description, quantity_available, image_url, category, status) VALUES
-- Study
('HDMI Projector', 'Portable projector with HDMI cable', 4, '/images/seed/Projector.jpg', 'study', 'active'),
('Whiteboard Markers Set', 'Set of 4 whiteboard markers + eraser', 10, NULL, 'study', 'active'),
('Extension Cord', '3-pin extension cord, 3m', 6, NULL, 'study', 'active'),
('Flip Chart Stand', 'Portable flip chart with paper pad', 3, NULL, 'study', 'active'),
-- Sports
('Basketball', 'Official size indoor/outdoor basketball', 8, NULL, 'sports', 'active'),
('Badminton Rackets (Pair)', 'Set of 2 rackets with shuttlecocks', 10, NULL, 'sports', 'active'),
('Tennis Racket', 'Full-size tennis racket', 6, NULL, 'sports', 'active'),
('Training Cones (Set of 10)', 'Agility cones for drills and marking', 5, NULL, 'sports', 'active'),
('Yoga Mats', 'Non-slip exercise mat', 15, NULL, 'sports', 'active'),
-- Computer Labs
('Wireless Mouse & Keyboard Set', 'Spare peripherals for lab workstations', 12, '/images/seed/Desktop_PC.jpg', 'computer_lab', 'active'),
('USB-C Docking Station', 'Multi-port dock for laptops', 6, '/images/seed/Laptop.jpg', 'computer_lab', 'active'),
('Portable SSD (1TB)', 'For large project or dataset transfers', 4, NULL, 'computer_lab', 'maintenance'),
-- Media & AV
('Bluetooth Speaker', 'Portable speaker for presentations', 3, NULL, 'media_av', 'active'),
('Webcam', 'USB webcam for video calls', 2, NULL, 'media_av', 'maintenance'),
('Ring Light', 'LED ring light with adjustable stand', 4, '/images/seed/Studio_Light.jpg', 'media_av', 'active'),
('DSLR Camera', 'Camera with tripod for filming projects', 3, '/images/seed/DSLR_Camera.jpg', 'media_av', 'active'),
('Lavalier Microphone', 'Clip-on mic with receiver for recording', 5, '/images/seed/Microphone.jpg', 'media_av', 'active'),
('Video Camera', 'Camcorder for video production', 2, '/images/seed/Video_Camera.jpg', 'media_av', 'active'),
('Tripod', 'Stable mount for cameras & mics', 6, '/images/seed/Tripod.jpg', 'media_av', 'active'),
('Headphones', 'For editing & recording booths', 8, '/images/seed/Headphones.jpg', 'media_av', 'active'),
-- Study / makerspace
('Microscope', 'For lab & science modules', 6, '/images/seed/Microscope.jpg', 'study', 'active'),
('3D Printer', 'For makerspace & project builds', 2, '/images/seed/3D_Printer.jpg', 'study', 'active'),
('Electronics Kit', 'Components for lab exercises', 8, '/images/seed/Electronics_Kit.jpg', 'study', 'active'),
-- Computer Labs
('Graphics Tablet', 'For design & media coursework', 6, '/images/seed/Graphics_Tablet.jpg', 'computer_lab', 'active'),
('Scanner', 'For document & project digitising', 3, '/images/seed/Scanner.jpg', 'computer_lab', 'active');

-- ============================================================
-- MIGRATION: run this against an existing database that was
-- created before 'rejected' was added as its own status
-- (admin rejections used to be stored as 'cancelled').
-- ============================================================
-- ALTER TABLE bookings MODIFY status ENUM(
--     'pending','approved','checked_in',
--     'completed','cancelled','rejected','expired'
-- ) NOT NULL DEFAULT 'pending';
