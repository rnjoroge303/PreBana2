const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const bcrypt = require("bcryptjs");
const { clearAuthCookie, issueAuthCookie, verifyRequestUser, verifyLegacyRequestUser } = require("../middleware/auth");

const usersFile = path.join(__dirname, "..", "data", "users.json");
const bcryptRounds = 12;
let usersWriteQueue = Promise.resolve();
let databaseStorePromise;

function usesDatabaseStore(){
    return process.env.VERCEL === "1"
        || [
            "DB_HOST",
            "DB_USER",
            "DB_PASSWORD",
            "DB_NAME",
            "MYSQL_ADDON_HOST",
            "MYSQL_ADDON_USER",
            "MYSQL_ADDON_PASSWORD",
            "MYSQL_ADDON_DB",
            "MYSQL_ADDON_URI"
        ].some((key) => Boolean(process.env[key]));
}

function normalizeRole(value){
    const role = String(value || "").trim().toLowerCase();
    return ["admin", "staff", "client"].includes(role) ? role : null;
}

function normalizeEmail(value){
    return String(value || "").trim().toLowerCase();
}

function isValidEmail(email){
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function getAdminBootstrapConfig(){
    const email = normalizeEmail(process.env.ADMIN_EMAIL);
    const password = String(process.env.ADMIN_PASSWORD || "");
    if (!email && !password){
        return null;
    }
    if (!isValidEmail(email) || Buffer.byteLength(password, "utf8") < 8 || Buffer.byteLength(password, "utf8") > 72){
        throw new Error("Configure ADMIN_EMAIL and an ADMIN_PASSWORD between 8 and 72 bytes to create the initial administrator.");
    }
    return { email, password };
}

async function readRawUsers(){
    try{
        const contents = await fs.readFile(usersFile, "utf8");
        const data = JSON.parse(contents);
        return Array.isArray(data.users) ? data.users : [];
    } catch(error){
        if (error.code === "ENOENT"){
            return [];
        }
        throw error;
    }
}

async function getDatabasePool(){
    if (!databaseStorePromise){
        databaseStorePromise = (async () => {
            const pool = require("../db/db");
            await pool.query(`
                CREATE TABLE IF NOT EXISTS prebana_users (
                    id VARCHAR(36) NOT NULL PRIMARY KEY,
                    email VARCHAR(254) NOT NULL,
                    role VARCHAR(16) NOT NULL,
                    password_hash VARCHAR(255) NOT NULL,
                    created_at DATETIME NOT NULL,
                    UNIQUE KEY uq_prebana_users_email (email)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);

            const entries = await readRawUsers();
            for (const entry of entries){
                const email = normalizeEmail(entry.email || entry.Email);
                const role = normalizeRole(entry.role || entry.Role);
                let passwordHash = entry.passwordHash;
                const legacyPassword = entry.Password || entry.password;

                if (!passwordHash && typeof legacyPassword === "string"){
                    passwordHash = await bcrypt.hash(legacyPassword, bcryptRounds);
                }
                if (!email || !isValidEmail(email) || !role || !passwordHash){
                    continue;
                }

                const createdAt = new Date(entry.createdAt || Date.now());
                await pool.execute(
                    `INSERT INTO prebana_users (id, email, role, password_hash, created_at)
                     VALUES (?, ?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE id = id`,
                    [
                        String(entry.id || crypto.randomUUID()),
                        email,
                        role,
                        passwordHash,
                        Number.isNaN(createdAt.getTime()) ? new Date() : createdAt
                    ]
                );
            }
            await provisionDatabaseAdmin(pool);
            return pool;
        })().catch((error) => {
            databaseStorePromise = null;
            throw error;
        });
    }
    return databaseStorePromise;
}

async function provisionDatabaseAdmin(pool){
    const bootstrap = getAdminBootstrapConfig();
    if (!bootstrap){
        return;
    }
    const [existingUsers] = await pool.execute(
        "SELECT role FROM prebana_users WHERE email = ?",
        [bootstrap.email]
    );
    if (existingUsers.length){
        if (normalizeRole(existingUsers[0].role) !== "admin"){
            throw new Error("ADMIN_EMAIL is already registered as a non-admin user.");
        }
        return;
    }

    await pool.execute(
        `INSERT IGNORE INTO prebana_users (id, email, role, password_hash, created_at)
         VALUES (?, ?, 'admin', ?, ?)`,
        [
            crypto.randomUUID(),
            bootstrap.email,
            await bcrypt.hash(bootstrap.password, bcryptRounds),
            new Date()
        ]
    );
    const [createdUsers] = await pool.execute(
        "SELECT role FROM prebana_users WHERE email = ?",
        [bootstrap.email]
    );
    if (!createdUsers.length || normalizeRole(createdUsers[0].role) !== "admin"){
        throw new Error("Could not provision the configured administrator account.");
    }
}

async function provisionFileAdmin(){
    const bootstrap = getAdminBootstrapConfig();
    if (!bootstrap){
        return;
    }
    const result = await updateUsers(async (users) => {
        const existing = users.find((user) => user.email === bootstrap.email);
        if (existing){
            if (existing.role !== "admin"){
                throw new Error("ADMIN_EMAIL is already registered as a non-admin user.");
            }
            return { skipWrite: true };
        }
        const passwordHash = await bcrypt.hash(bootstrap.password, bcryptRounds);
        const user = {
            id: crypto.randomUUID(),
            email: bootstrap.email,
            role: "admin",
            passwordHash,
            createdAt: new Date().toISOString()
        };
        users.push(user);
        return { user };
    });
    return result.user;
}

async function readUsers(){
    if (usesDatabaseStore()){
        const pool = await getDatabasePool();
        const [users] = await pool.execute(
            "SELECT id, email, role, password_hash AS passwordHash, created_at AS createdAt FROM prebana_users"
        );
        return users.map((user) => ({
            id: user.id,
            email: normalizeEmail(user.email),
            role: normalizeRole(user.role),
            passwordHash: user.passwordHash,
            createdAt: new Date(user.createdAt || Date.now()).toISOString()
        })).filter((user) => user.id && user.email && user.role && user.passwordHash);
    }

    const entries = await readRawUsers();
    return entries.map((entry) => ({
        id: entry.id,
        email: normalizeEmail(entry.email || entry.Email),
        role: normalizeRole(entry.role || entry.Role),
        passwordHash: entry.passwordHash,
        createdAt: entry.createdAt || new Date().toISOString()
    })).filter((user) => user.id && user.email && user.role && user.passwordHash);
}

async function createDatabaseUser(user){
    const pool = await getDatabasePool();
    try{
        await pool.execute(
            `INSERT INTO prebana_users (id, email, role, password_hash, created_at)
             VALUES (?, ?, ?, ?, ?)`,
            [user.id, user.email, user.role, user.passwordHash, new Date(user.createdAt)]
        );
        return { user };
    } catch(error){
        if (error.code === "ER_DUP_ENTRY"){
            return { duplicate: true, skipWrite: true };
        }
        throw error;
    }
}

async function writeUsers(users){
    await fs.mkdir(path.dirname(usersFile), { recursive: true });
    const temporaryFile = `${usersFile}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporaryFile, JSON.stringify({ users }, null, 2), "utf8");
    await fs.rename(temporaryFile, usersFile);
}

function updateUsers(change){
    const operation = usersWriteQueue.then(async () => {
        const users = await readUsers();
        const result = await change(users);
        if (!result.skipWrite){
            await writeUsers(users);
        }
        return result;
    });
    usersWriteQueue = operation.catch(() => {});
    return operation;
}

async function initializeUserStore(){
    if (usesDatabaseStore()){
        await getDatabasePool();
        return;
    }

    const originalEntries = await readRawUsers();
    const users = [];
    for (const entry of originalEntries){
        const role = normalizeRole(entry.role || entry.Role);
        const email = normalizeEmail(entry.email || entry.Email);
        let passwordHash = entry.passwordHash;
        const legacyPassword = entry.Password || entry.password;

        if (!passwordHash && typeof legacyPassword === "string"){
            passwordHash = await bcrypt.hash(legacyPassword, bcryptRounds);
        }
        if (!role || !isValidEmail(email) || !passwordHash){
            continue;
        }
        users.push({
            id: entry.id || crypto.randomUUID(),
            email,
            role,
            passwordHash,
            createdAt: entry.createdAt || new Date().toISOString()
        });
    }

    if (JSON.stringify(originalEntries) !== JSON.stringify(users)){
        await writeUsers(users);
    }
    await provisionFileAdmin();
}

function landingForRole(role){
    if (role === "admin"){
        return "/pre/admin";
    }
    return role === "staff" ? "/pre/admin#pos" : "/pre/store";
}

function getPostAuthPath(role, requestedPath){
    return role === "client" && requestedPath === "/pre/checkout"
        ? requestedPath
        : landingForRole(role);
}

function renderLogin(role, res, error = null, status = 200, next = null){
    return res.status(status).render(`${role}/login`, { error, next });
}

function renderSignup(role, res, error = null, status = 200, next = null){
    return res.status(status).render(`${role}/signup`, { error, next });
}

async function login(req, res, role){
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || "");
    const users = await readUsers();
    const roles = role === "admin" ? ["admin", "staff"] : [role];
    const user = users.find((entry) => entry.email === email && roles.includes(entry.role));

    if (!user || !await bcrypt.compare(password, user.passwordHash)){
        return renderLogin(role, res, "Email or password is incorrect.", 401);
    }

    issueAuthCookie(res, user);
    return res.redirect(getPostAuthPath(user.role, req.body.next));
}

async function createUserAccount(email, password, role){
    const user = {
        id: crypto.randomUUID(),
        email,
        role,
        passwordHash: await bcrypt.hash(password, bcryptRounds),
        createdAt: new Date().toISOString()
    };
    return usesDatabaseStore()
        ? createDatabaseUser(user)
        : updateUsers((users) => {
            if (users.some((entry) => entry.email === email)){
                return { duplicate: true, skipWrite: true };
            }
            users.push(user);
            return { user };
        });
}

async function listStaffUsers(){
    return (await readUsers())
        .filter((user) => user.role === "staff")
        .map(({ id, email, createdAt }) => ({ id, email, createdAt }));
}

async function createStaffAccount(req, res, next){
    try{
        const email = normalizeEmail(req.body?.email);
        const password = String(req.body?.password || "");
        const confirmPassword = String(req.body?.confirmPassword || "");
        if (!isValidEmail(email)){
            return res.status(400).json({ error: "Enter a valid email address." });
        }
        if (Buffer.byteLength(password, "utf8") < 8 || Buffer.byteLength(password, "utf8") > 72){
            return res.status(400).json({ error: "Staff passwords must be 8–72 bytes." });
        }
        if (password !== confirmPassword){
            return res.status(400).json({ error: "The passwords do not match." });
        }
        const result = await createUserAccount(email, password, "staff");
        if (result.duplicate){
            return res.status(409).json({ error: "An account with that email already exists." });
        }
        return res.status(201).json({
            staff: {
                id: result.user.id,
                email: result.user.email,
                createdAt: result.user.createdAt
            }
        });
    } catch(error){
        return next(error);
    }
}

async function signup(req, res, role){
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || "");
    const confirmPassword = String(req.body.confirmPassword || "");
    const next = getPostAuthPath(role, req.body.next);
    const renderPage = (message, status = 400) => renderSignup(role, res, message, status, next);

    if (!isValidEmail(email)){
        return renderPage("Enter a valid email address.");
    }
    if (Buffer.byteLength(password, "utf8") < 8){
        return renderPage("Use a password with at least 8 characters.");
    }
    if (Buffer.byteLength(password, "utf8") > 72){
        return renderPage("Password must be 72 bytes or fewer.");
    }
    if (password !== confirmPassword){
        return renderPage("The passwords do not match.");
    }

    const result = await createUserAccount(email, password, role);
    if (result.duplicate){
        return renderPage("An account with that email already exists.", 409);
    }
    issueAuthCookie(res, result.user);
    return res.redirect(next);
}

function showAdminLogin(req, res){
    return renderLogin("admin", res);
}

function showClientLogin(req, res){
    return renderLogin("client", res, null, 200, getPostAuthPath("client", req.query.next));
}

function showAdminSignup(req, res){
    return renderSignup("admin", res);
}

function showClientSignup(req, res){
    return renderSignup("client", res, null, 200, getPostAuthPath("client", req.query.next));
}

function loginAdmin(req, res, next){
    return login(req, res, "admin").catch(next);
}

function loginClient(req, res, next){
    return login(req, res, "client").catch(next);
}

function signupAdmin(req, res, next){
    return signup(req, res, "admin").catch(next);
}

function signupClient(req, res, next){
    return signup(req, res, "client").catch(next);
}

function logout(req, res){
    const requestedRole = String(req.body.role || "").trim();
    const role = requestedRole === "admin" || requestedRole === "client" || requestedRole === "staff"
        ? requestedRole
        : verifyRequestUser(req)?.role;
    const legacyUser = role ? verifyLegacyRequestUser(req, role) : null;
    clearAuthCookie(res, role, Boolean(legacyUser));
    return res.redirect(role === "client" ? "/pre/client/login" : "/pre/admin/login");
}

module.exports = {
    initializeUserStore,
    createStaffAccount,
    loginAdmin,
    loginClient,
    logout,
    showAdminLogin,
    showAdminSignup,
    showClientLogin,
    showClientSignup,
    listStaffUsers,
    signupAdmin,
    signupClient
};
