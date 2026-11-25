const checkoutController = require("./checkoutController");
const productController = require("./productController");
const authController = require("./authController");
const shippingStore = require("../models/shippingStore");

async function showDashboard(req, res, next) {
    try {
        if (req.authUser.role === "staff"){
            const products = await productController.readProducts();
            return res.render("admin/staffDashboard", {
                operator: req.authUser,
                products
            });
        }
        const [products, customers, orders, shippingRates] = await Promise.all([
            productController.readProducts(),
            checkoutController.listCustomers(),
            checkoutController.readOrders(),
            shippingStore.readRates()
        ]);
        const staff = await authController.listStaffUsers();
        const now = new Date();
        const currentPeriodStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        const previousPeriodStart = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
        const paidOrders = orders.filter((order) => order.paymentStatus === "paid");
        const paidDate = (order) => new Date(order.paymentConfirmedAt || order.createdAt);
        const currentPaidOrders = paidOrders.filter((order) => paidDate(order) >= currentPeriodStart && paidDate(order) <= now);
        const previousPaidOrders = paidOrders.filter((order) => paidDate(order) >= previousPeriodStart && paidDate(order) < currentPeriodStart);
        const currentRevenue = currentPaidOrders.reduce((total, order) => total + Number(order.total || 0), 0);
        const previousRevenue = previousPaidOrders.reduce((total, order) => total + Number(order.total || 0), 0);
        const currentPlacedOrders = orders.filter((order) => new Date(order.createdAt) >= currentPeriodStart && new Date(order.createdAt) <= now);
        const paidCurrentPlacedOrders = currentPlacedOrders.filter((order) => order.paymentStatus === "paid").length;
        const productCategories = new Map(products.map((product) => [product.id, product.category]));
        const categoryRevenue = new Map();
        currentPaidOrders.forEach((order) => {
            (Array.isArray(order.items) ? order.items : []).forEach((item) => {
                const category = productCategories.get(item.productId) || "other";
                categoryRevenue.set(category, (categoryRevenue.get(category) || 0) + Number(item.lineTotal || 0));
            });
        });
        const categoryNames = {
            featured: "Featured",
            hair: "Hair care",
            face: "Face care",
            body: "Body care",
            baby: "Baby care",
            nails: "Nails",
            mens: "Men's care",
            other: "Other"
        };
        const categoryRows = [...categoryRevenue]
            .map(([category, revenue]) => ({
                name: categoryNames[category] || categoryNames.other,
                revenue,
                share: currentRevenue > 0 ? Math.round(revenue / currentRevenue * 100) : 0
            }))
            .sort((left, right) => right.revenue - left.revenue)
            .slice(0, 5);
        const weeklyRevenue = Array.from({ length: 5 }, (_, index) => {
            const start = new Date(now.getTime() - (4 - index) * 7 * 24 * 60 * 60 * 1000);
            start.setHours(0, 0, 0, 0);
            const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
            const revenue = paidOrders
                .filter((order) => paidDate(order) >= start && paidDate(order) < end)
                .reduce((total, order) => total + Number(order.total || 0), 0);
            return { label: start.toLocaleDateString("en-KE", { day: "numeric", month: "short" }), revenue };
        });
        const maximumWeeklyRevenue = Math.max(1, ...weeklyRevenue.map((week) => week.revenue));
        weeklyRevenue.forEach((week) => {
            week.height = Math.max(3, Math.round(week.revenue / maximumWeeklyRevenue * 100));
        });
        const revenueChange = previousRevenue > 0
            ? Math.round((currentRevenue - previousRevenue) / previousRevenue * 100)
            : currentRevenue > 0 ? null : 0;
        const weekStart = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const weeklyPaidOrders = paidOrders.filter((order) => new Date(order.paymentConfirmedAt || order.createdAt).getTime() >= weekStart);
        const dailySales = Array.from({ length: 7 }, (_, index) => {
            const day = new Date();
            day.setUTCHours(0, 0, 0, 0);
            day.setUTCDate(day.getUTCDate() - (6 - index));
            const dayKey = day.toISOString().slice(0, 10);
            const sales = weeklyPaidOrders
                .filter((order) => String(order.paymentConfirmedAt || order.createdAt).slice(0, 10) === dayKey)
                .reduce((total, order) => total + Number(order.total || 0), 0);
            return { day, sales };
        });
        const maximumDailySales = Math.max(1, ...dailySales.map((entry) => entry.sales));
        dailySales.forEach((entry) => {
            entry.height = Math.max(3, Math.round(entry.sales / maximumDailySales * 100));
        });
        const reports = {
            revenue: currentRevenue,
            revenueChange,
            paidOrderCount: currentPaidOrders.length,
            averageOrderValue: currentPaidOrders.length ? currentRevenue / currentPaidOrders.length : 0,
            paymentRate: currentPlacedOrders.length
                ? Math.round(paidCurrentPlacedOrders / currentPlacedOrders.length * 100)
                : 0,
            placedOrderCount: currentPlacedOrders.length,
            weeklyRevenue,
            categoryRows
        };
        res.render("dashboard", {
            products,
            customers,
            orders: orders.filter((order) => order.salesChannel !== "physical"),
            allOrders: [...orders].sort((left, right) =>
                String(right.createdAt || "").localeCompare(String(left.createdAt || ""))
            ),
            authUser: req.authUser,
            reports,
            staff,
            counties: shippingStore.COUNTIES,
            shippingRates,
            stats: {
                grossSales: paidOrders.reduce((total, order) => total + Number(order.total || 0), 0),
                weeklySales: weeklyPaidOrders.reduce((total, order) => total + Number(order.total || 0), 0),
                totalOrders: orders.length,
                pendingPayments: orders.filter((order) => order.paymentStatus !== "paid").length,
                recentOrders: orders.slice(0, 4),
                dailySales,
                dailySalesScale: maximumDailySales
            },
            productId: productController.generateProductId(products)
        });
    } catch (error) {
        next(error);
    }
}

module.exports = { showDashboard };
