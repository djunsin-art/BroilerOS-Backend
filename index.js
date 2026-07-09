// ============================================================
// BROILEROS BACKEND v2.1 FINAL (Render Ready)
// ============================================================


// ============================================================
// PAKSA IPv4 (SOLUSI UNTUK RENDER + SUPABASE)
// ============================================================

const dns = require('dns');
dns.setDefaultResultOrder('ipv4first'); // <-- INI KUNCI NYA

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'broileros-super-secret-key';

// SECURITY
app.use(helmet());
const allowedOrigins = [
    'https://broileros-app.pages.dev',
    'http://localhost:5173',
    'http://localhost:3000',
    'https://broileros.onrender.com'
];
app.use(cors({
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true
}));

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: { error: 'Terlalu banyak percobaan login. Coba lagi 15 menit.' }
});

app.use(express.json({ limit: '10mb' }));

// ============================================================
// DATABASE CONNECTION
// ============================================================
console.log('🔌 Mencoba koneksi ke database...');
if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL tidak ditemukan di environment variables!');
    console.error('⚠️ Server tetap berjalan, tetapi endpoint database akan error.');
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
});

pool.connect((err, client, release) => {
    if (err) {
        console.error('❌ Database connection failed:', err.message || err);
        console.log('⚠️ Server tetap berjalan tanpa database.');
    } else {
        console.log('✅ Database connected successfully.');
        release();
    }
});

pool.on('error', (err) => {
    console.error('❌ Database error:', err.message);
});

// ============================================================
// ROUTES
// ============================================================
app.get('/', (req, res) => res.send('BroilerOS Backend is running!'));

app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

app.get('/test-db', async (req, res) => {
    try {
        if (!process.env.DATABASE_URL) {
            return res.status(500).json({
                success: false,
                error: 'DATABASE_URL is not set in environment variables'
            });
        }
        const result = await pool.query('SELECT NOW()');
        res.json({
            success: true,
            time: result.rows[0].now,
            db_url_set: !!process.env.DATABASE_URL
        });
    } catch (err) {
        console.error('Test DB error:', err);
        res.status(500).json({
            success: false,
            error: err.message || 'Unknown error'
        });
    }
});

// ============================================================
// AUTH
// ============================================================
app.get('/api/users/public', async (req, res) => {
    const { role } = req.query;
    let query = 'SELECT id, name, role FROM users WHERE active = true';
    const params = [];
    if (role) { query += ' AND role = $1'; params.push(role); }
    const result = await pool.query(query, params);
    res.json(result.rows);
});

// === GLOBAL STATS ===
app.get('/api/admin/global-stats', auth, async (req, res) => {
    if (!req.isSuperAdmin) return res.status(403).json({ error: 'Akses khusus Super Admin' });
    // ... isi query ...
});

app.post('/api/auth/login', loginLimiter, async (req, res) => {
    const { userId, pin } = req.body;
    if (!userId || !pin) return res.status(400).json({ error: 'User ID dan PIN wajib' });
    if (!userId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) return res.status(400).json({ error: 'Format User ID tidak valid' });
    if (!pin.match(/^[0-9]{4,6}$/)) return res.status(400).json({ error: 'PIN harus 4-6 digit angka' });
    
    const result = await pool.query('SELECT * FROM users WHERE id = $1 AND active = true', [userId]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'User tidak ditemukan' });
    const user = result.rows[0];
    const valid = await bcrypt.compare(pin, user.pin_hash);
    if (!valid) return res.status(401).json({ error: 'PIN salah' });
    
    const farm = await pool.query('SELECT name FROM farms WHERE id = $1', [user.farm_id]);
    const token = jwt.sign({ id: user.id, role: user.role, farm_id: user.farm_id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, name: user.name, role: user.role, farm_id: user.farm_id, barn_id: user.barn_id, floor_id: user.floor_id, farm_name: farm.rows[0]?.name || 'Farm', is_super_admin: user.is_super_admin || false } });
});

// ============================================================
// ADMIN SETUP (SUPER ADMIN)
// ============================================================
app.post('/api/admin/setup', async (req, res) => {
    const { name, pin, farmName } = req.body;
    if (!name || !pin) return res.status(400).json({ error: 'Name dan PIN wajib' });
    
    const hash = await bcrypt.hash(pin, 10);
    let farmId;
    const farmRes = await pool.query('SELECT id FROM farms LIMIT 1');
    if (farmRes.rows.length === 0) {
        const newFarm = await pool.query('INSERT INTO farms (name, owner_name) VALUES ($1, $2) RETURNING id', [farmName || 'Hemita Farm', name]);
        farmId = newFarm.rows[0].id;
    } else {
        farmId = farmRes.rows[0].id;
    }
    
    const existing = await pool.query('SELECT id FROM users WHERE is_super_admin = true LIMIT 1');
    if (existing.rows.length > 0) return res.status(400).json({ error: 'Super Admin sudah ada.' });
    
    const result = await pool.query('INSERT INTO users (name, pin_hash, role, farm_id, is_super_admin) VALUES ($1, $2, $3, $4, $5) RETURNING id', [name, hash, 'manager', farmId, true]);
    res.status(201).json({ message: 'Super Admin created!', id: result.rows[0].id });
});

// ============================================================
// GLOBAL STATS (Super Admin Only)
// ============================================================
app.get('/api/admin/global-stats', auth, async (req, res) => {
    if (!req.isSuperAdmin) {
        return res.status(403).json({ error: 'Akses khusus Super Admin' });
    }

    try {
        const totalFarms = await pool.query('SELECT COUNT(*) FROM farms');
        const totalBarns = await pool.query('SELECT COUNT(*) FROM barns');
        const totalUsers = await pool.query('SELECT COUNT(*) FROM users');
        const totalReports = await pool.query('SELECT COUNT(*) FROM telemetry_reports');
        const avgRisk = await pool.query('SELECT AVG(risk_score) FROM telemetry_reports');
        const topRisks = await pool.query(`
            SELECT r.*, f.name as farm_name, u.name as user_name, b.name as barn_name, fl.name as floor_name
            FROM telemetry_reports r 
            JOIN farms f ON r.farm_id = f.id 
            LEFT JOIN users u ON r.user_id = u.id 
            LEFT JOIN barns b ON r.barn_id = b.id 
            LEFT JOIN floors fl ON r.floor_id = fl.id
            ORDER BY r.risk_score DESC LIMIT 10
        `);

        res.json({
            totalFarms: parseInt(totalFarms.rows[0].count),
            totalBarns: parseInt(totalBarns.rows[0].count),
            totalUsers: parseInt(totalUsers.rows[0].count),
            totalReports: parseInt(totalReports.rows[0].count),
            avgRisk: parseFloat(avgRisk.rows[0].avg) || 0,
            topRisks: topRisks.rows
        });
    } catch (err) {
        console.error('Global stats error:', err);
        res.status(500).json({ error: 'Gagal mengambil data global', detail: err.message });
    }
});

// ============================================================
// START
// ============================================================
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 BroilerOS Backend running on port ${PORT}`);
    console.log(`📡 Health: /api/health`);
    console.log(`📡 Test DB: /test-db`);
});