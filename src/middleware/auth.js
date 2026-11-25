const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");

const legacyTokenCookieName = "prebana_token";
const tokenCookieNames = {
    admin: "prebana_admin_token",
    client: "prebana_client_token",
    staff: "prebana_staff_token"
};
const allowedRoles = ["admin", "client", "staff"];
const developmentSecret = crypto.createHash("sha256")
    .update("prebana-local-development-only")
    .digest("hex");
const jwtSecret = process.env.JWT_SECRET || (process.env.NODE_ENV === "production" ? null : developmentSecret);

if (!jwtSecret) {
    throw new Error("JWT_SECRET must be configured in production.");
}

function readCookie(req, cookieName) {
    const cookies = String(req.headers.cookie || "").split(";");
    const tokenCookie = cookies.map((cookie) => cookie.trim()).find((cookie) => cookie.startsWith(`${cookieName}=`));
    if (!tokenCookie) {
        return null;
    }
    try {
        return decodeURIComponent(tokenCookie.slice(cookieName.length + 1));
    } catch {
        return null;
    }
}

function verifyToken(token, expectedRole) {
    if (!token) {
        return null;
    }
    try {
        const payload = jwt.verify(token, jwtSecret, { issuer: "prebana-store" });
        const expectedRoles = Array.isArray(expectedRole) ? expectedRole : expectedRole ? [expectedRole] : null;
        if (!payload.sub || !allowedRoles.includes(payload.role) || (expectedRoles && !expectedRoles.includes(payload.role))) {
            return null;
        }
        return { id: payload.sub, email: payload.email, role: payload.role };
    } catch {
        return null;
    }
}

function verifyRequestUser(req, expectedRole) {
    if (expectedRole) {
        const expectedRoles = Array.isArray(expectedRole) ? expectedRole : [expectedRole];
        for (const role of expectedRoles){
            const roleToken = readCookie(req, tokenCookieNames[role]);
            const roleUser = verifyToken(roleToken, expectedRoles);
            if (roleUser){
                return roleUser;
            }
        }
        return verifyToken(readCookie(req, legacyTokenCookieName), expectedRoles);
    }

    return verifyToken(readCookie(req, tokenCookieNames.admin), "admin")
        || verifyToken(readCookie(req, tokenCookieNames.staff), "staff")
        || verifyToken(readCookie(req, tokenCookieNames.client), "client")
        || verifyToken(readCookie(req, legacyTokenCookieName));
}

function verifyLegacyRequestUser(req, expectedRole) {
    return verifyToken(readCookie(req, legacyTokenCookieName), expectedRole);
}

function issueAuthCookie(res, user) {
    const token = jwt.sign({ email: user.email, role: user.role }, jwtSecret, {
        subject: user.id,
        issuer: "prebana-store",
        expiresIn: "8h"
    });
    res.cookie(tokenCookieNames[user.role], token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        path: "/pre",
        maxAge: 8 * 60 * 60 * 1000
    });
}

function clearAuthCookie(res, role, clearLegacy = false) {
    const cookieOptions = {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        path: "/pre"
    };
    if (role && tokenCookieNames[role]) {
        res.clearCookie(tokenCookieNames[role], cookieOptions);
        if (clearLegacy) {
            res.clearCookie(legacyTokenCookieName, cookieOptions);
        }
        return;
    }
    Object.values(tokenCookieNames).forEach((cookieName) => res.clearCookie(cookieName, cookieOptions));
    res.clearCookie(legacyTokenCookieName, cookieOptions);
}

function requireRole(requiredRole) {
    return (req, res, next) => {
        const user = verifyRequestUser(req, requiredRole);
        if (!user) {
            clearAuthCookie(res, requiredRole);
            if (String(req.get("Accept") || "").includes("application/json")) {
                return res.status(401).json({ error: "Your session has expired. Please sign in again." });
            }
            const loginRole = Array.isArray(requiredRole) ? requiredRole[0] : requiredRole;
            return res.redirect(`/pre/${loginRole}/login`);
        }
        req.authUser = user;
        res.locals.authUser = user;
        return next();
    };
}

module.exports = {
    clearAuthCookie,
    issueAuthCookie,
    requireRole,
    verifyRequestUser,
    verifyLegacyRequestUser
};
