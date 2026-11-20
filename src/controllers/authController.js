const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const bcrypt = require("bcryptjs");
const { clearAuthCookie, issueAuthCookie, verifyRequestUser, verifyLegacyRequestUser } = require("../middleware/auth");

const usersFile = path.join(__dirname, "..", "data", "users.json");
const bcryptRounds = 12;
let usersWriteQueue = Promise.resolve();

function normalizeRole(value){
    const role = String(value || "").trim().toLowerCase();
    return role === "admin" ? "admin" : role === "client" ? "client" : null;
}

function normalizeEmail(value){
    return String(value || "").trim().toLowerCase();
}

function isValidEmail(email){
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
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

async function readUsers(){
    const entries = await readRawUsers();
    return entries.map((entry) => ({
        id: entry.id,
        email: normalizeEmail(entry.email || entry.Email),
        role: normalizeRole(entry.role || entry.Role),
        passwordHash: entry.passwordHash
    })).filter((user) => user.id && user.email && user.role && user.passwordHash);
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
}

function landingForRole(role){
    return role === "admin" ? "/pre/admin" : "/pre/store";
}

function renderLogin(role, res, error = null, status = 200){
    return res.status(status).render(`${role}/login`, { error });
}

function renderSignup(role, res, error = null, status = 200){
    return res.status(status).render(`${role}/signup`, { error });
}

async function login(req, res, role){
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || "");
    const users = await readUsers();
    const user = users.find((entry) => entry.email === email && entry.role === role);

    if (!user || !await bcrypt.compare(password, user.passwordHash)){
        return renderLogin(role, res, "Email or password is incorrect.", 401);
    }

    issueAuthCookie(res, user);
    return res.redirect(landingForRole(role));
}

async function signup(req, res, role){
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || "");
    const confirmPassword = String(req.body.confirmPassword || "");
    const renderPage = (message, status = 400) => renderSignup(role, res, message, status);

    if (!isValidEmail(email)){
        return renderPage("Enter a valid email address.");
    }
    if (Buffer.byteLength(password, "utf8") < 12){
        return renderPage("Use a password with at least 12 characters.");
    }
    if (Buffer.byteLength(password, "utf8") > 72){
        return renderPage("Password must be 72 bytes or fewer.");
    }
    if (password !== confirmPassword){
        return renderPage("The passwords do not match.");
    }

    const passwordHash = await bcrypt.hash(password, bcryptRounds);
    const result = await updateUsers((users) => {
        if (users.some((user) => user.email === email)){
            return { duplicate: true, skipWrite: true };
        }
        const user = {
            id: crypto.randomUUID(),
            email,
            role,
            passwordHash,
            createdAt: new Date().toISOString()
        };
        users.push(user);
        return { user };
    });

    if (result.duplicate){
        return renderPage("An account with that email already exists.", 409);
    }

    issueAuthCookie(res, result.user);
    return res.redirect(landingForRole(role));
}

function showAdminLogin(req, res){
    return renderLogin("admin", res);
}

function showClientLogin(req, res){
    return renderLogin("client", res);
}

function showAdminSignup(req, res){
    return renderSignup("admin", res);
}

function showClientSignup(req, res){
    return renderSignup("client", res);
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
    const role = requestedRole === "admin" || requestedRole === "client"
        ? requestedRole
        : verifyRequestUser(req)?.role;
    const legacyUser = role ? verifyLegacyRequestUser(req, role) : null;
    clearAuthCookie(res, role, Boolean(legacyUser));
    return res.redirect(role === "admin" ? "/pre/admin/login" : "/pre/client/login");
}

module.exports = {
    initializeUserStore,
    loginAdmin,
    loginClient,
    logout,
    showAdminLogin,
    showAdminSignup,
    showClientLogin,
    showClientSignup,
    signupAdmin,
    signupClient
};
