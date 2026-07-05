// ============================================================
// BROILEROS v2.1 FINAL - BACKEND (MINIMAL & STABLE)
// ============================================================
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'broileros-super-secret-key';

// ============================================================
// MIDDLEWARE
// ============================================================
app.use(helmet());
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

// ============================================================
// DATABASE CONNECTION (Dengan Error Handling Jelas)
// ============================================================
console.log('🔌 Attempting to connect to database...');
console.log('📡 DATABASE_URL is', process.env.DATABASE_URL ? 'SET' : 'NOT SET');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
});

pool.connect((err, client, release) => {
    if (err) {
        console.error('❌ Database connection failed:', err.message);
        console.error('   Stack trace:', err.stack);
        // Jangan exit, biarkan server tetap jalan
    } else {
        console.log('✅ Database connected successfully.');
        release();
    }
});

pool.on('error', (err) => {
    console.error('❌ Unexpected database error:', err.message);
});

// ============================================================
// SIMPLE ROUTES (Untuk Testing)
// ============================================================

// Health Check
app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Test Database
app.get('/api/test-db', async (req, res) => {
    try {
        const result = await pool.query('SELECT NOW()');
        res.json({ success: true, time: result.rows[0].now });
    } catch (err) {
        console.error('Test DB error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// === ADMIN SETUP (Super Admin) ===
app.post('/api/admin/setup', async (req, res) => {
    const { name, pin, farmName } = req.body;
    if (!name || !pin) return res.status(400).json({ error: 'Name dan PIN wajib' });
    try {
        const hash = await bcrypt.hash(pin, 10);
        let farmId;
        const farmRes = await pool.query('SELECT id FROM farms LIMIT 1');
        if (farmRes.rows.length === 0) {
            const newFarm = await pool.query(
                'INSERT INTO farms (name, owner_name) VALUES ($1, $2) RETURNING id',
                [farmName || 'Hemita Farm', name]
            );
            farmId = newFarm.rows[0].id;
        } else {
            farmId = farmRes.rows[0].id;
        }
        const existing = await pool.query('SELECT id FROM users WHERE is_super_admin = true LIMIT 1');
        if (existing.rows.length > 0) {
            return res.status(400).json({ error: 'Super Admin sudah ada.' });
        }
        const result = await pool.query(
            'INSERT INTO users (name, pin_hash, role, farm_id, is_super_admin) VALUES ($1, $2, $3, $4, $5) RETURNING id',
            [name, hash, 'manager', farmId, true]
        );
        res.status(201).json({ message: 'Super Admin created!', id: result.rows[0].id });
    } catch (err) {
        console.error('Setup error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// START SERVER (DENGAN BIND KE 0.0.0.0)
// ============================================================
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 BroilerOS Backend running on port ${PORT}`);
    console.log(`🔗 Health check: /api/health`);
    console.log(`🔗 Test DB: /api/test-db`);
});
// ============================================================
// DATABASE CONNECTION (TANPA CRASH)
// ============================================================
console.log('🔌 Mencoba koneksi ke database...');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
    max: 10,
});

// Test koneksi TANPA menghentikan server
pool.connect((err, client, release) => {
    if (err) {
        console.error('❌ Database connection failed:', err.message);
        console.error('📡 DATABASE_URL is', process.env.DATABASE_URL ? 'SET' : 'NOT SET');
        console.log('⚠️ Server tetap berjalan, tetapi endpoint database akan error.');
        // JANGAN panggil process.exit(1) - biarkan server tetap hidup
    } else {
        console.log('✅ Database connected successfully.');
        release();
    }
});

// Event listener untuk error pool (jangan crash)
pool.on('error', (err) => {
    console.error('❌ Unexpected database error:', err.message);
    // JANGAN throw err - cukup log
});

// Route test TANPA database (untuk cek server hidup)
app.get('/ping', (req, res) => {
    res.json({ 
        status: 'OK', 
        message: 'Server is running!',
        timestamp: new Date().toISOString()
    });
});
