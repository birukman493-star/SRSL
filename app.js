const express = require("express");
const session = require("express-session");
const bodyParser = require("body-parser");
const cookieParser = require("cookie-parser");
const path = require("node:path");
const bcrypt = require("bcryptjs");
require("dotenv").config();

// Import database configuration
const { pool, initDatabase } = require("./config/db");

const app = express();

// Middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

// Session configuration
app.use(
  session({
    secret: process.env.SESSION_SECRET || "fallback-secret-key",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    },
  })
);

// View engine setup - Using EJS for standard and reliable template rendering
app.set("view engine", "html");
app.engine("html", require("ejs").renderFile);
app.set("views", path.join(__dirname, "views"));

// Global middleware to pass session variables to all templates
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.success = req.session.flash ? req.session.flash.success : null;
  res.locals.error = req.session.flash ? req.session.flash.error : null;
  // Clear flash after using it
  delete req.session.flash;
  next();
});

// Initialize database
initDatabase().catch(err => console.error("Database initialization error:", err));

// Routes
const authRoutes = require("./routes/auth");
const adminRoutes = require("./routes/admin");
const studentRoutes = require("./routes/student");
const teacherRoutes = require("./routes/teacher");
const parentRoutes = require("./routes/parent");

app.use("/auth", authRoutes);
app.use("/admin", adminRoutes);
app.use("/student", studentRoutes);
app.use("/teacher", teacherRoutes);
app.use("/parent", parentRoutes);

// Main routes - Updated to use modern templates
app.get("/", async (req, res) => {
  try {
    const [studentCount] = await pool.query('SELECT COUNT(*) as count FROM students WHERE is_active = 1');
    const [teacherCount] = await pool.query('SELECT COUNT(*) as count FROM teachers WHERE is_active = 1');
    const [parentCount] = await pool.query('SELECT COUNT(*) as count FROM parents');
    
    res.render("index-modern", {
      title: "Student Registration and Management System",
      stats: {
        students: studentCount[0].count,
        teachers: teacherCount[0].count,
        parents: parentCount[0].count,
        schools: 1, 
        countries: 1
      }
    });
  } catch (error) {
    console.error("Error fetching stats for homepage:", error);
    res.render("index-modern", {
      title: "Student Registration and Management System",
      stats: { students: 0, teachers: 0, parents: 0, schools: 1, countries: 1 }
    });
  }
});

app.get("/about", async (req, res) => {
  try {
    const [studentCount] = await pool.query('SELECT COUNT(*) as count FROM students WHERE is_active = 1');
    const [teacherCount] = await pool.query('SELECT COUNT(*) as count FROM teachers WHERE is_active = 1');
    const [parentCount] = await pool.query('SELECT COUNT(*) as count FROM parents');

    res.render("about-modern", { 
      title: "About Us",
      stats: {
        students: studentCount[0].count,
        teachers: teacherCount[0].count,
        parents: parentCount[0].count,
        schools: 1,
        countries: 1
      }
    });
  } catch (error) {
    console.error("Error fetching stats for about page:", error);
    res.render("about-modern", { 
      title: "About Us",
      stats: { students: 0, teachers: 0, parents: 0, schools: 1, countries: 1 }
    });
  }
});

app.get("/contact", (req, res) => {
  res.render("contact-modern", {
    title: "Contact Us",
    error: null,
    success: null,
  });
});

app.post("/contact", async (req, res) => {
  console.log(">>> Route Hit: /contact (POST)");
  try {
    const { firstName, lastName, email, subject, message } = req.body;

    // Validate required fields
    if (!firstName || !lastName || !email || !subject || !message) {
      return res.render("contact-modern", {
        title: "Contact Us",
        error: "All fields are required",
        success: null,
      });
    }

    // Combine first and last name
    const name = `${firstName} ${lastName}`;

    // Insert contact message into database
    await pool.execute(
      `
      INSERT INTO contact_messages (name, email, subject, message)
      VALUES (?, ?, ?, ?)
    `,
      [name, email, subject, message]
    );

    res.render("contact-modern", {
      title: "Contact Us",
      success: "Message sent successfully! We will get back to you soon.",
      error: null,
    });
  } catch (error) {
    console.error("Contact form error:", error);
    res.render("contact-modern", {
      title: "Contact Us",
      error: "Failed to send message. Please try again.",
      success: null,
    });
  }
});

app.get("/gallery", (req, res) => {
  res.render("gallery-modern", { title: "Gallery" });
});

// Dashboard route - redirects based on role
app.get("/dashboard", (req, res) => {
  if (!req.session.user) {
    return res.redirect("/auth/login");
  }

  const role = req.session.user.role;
  switch (role) {
    case "admin":
      res.redirect("/admin/dashboard");
      break;
    case "student":
      res.redirect("/student/dashboard");
      break;
    case "teacher":
      res.redirect("/teacher/dashboard");
      break;
    case "parent":
      res.redirect("/parent/dashboard");
      break;
    default:
      res.redirect("/");
  }
});

// Logout
app.get("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.redirect("/dashboard");
    }
    res.clearCookie("connect.sid");
    res.redirect("/");
  });
});

// Health check endpoint for error page
app.get("/api/health", (req, res) => {
  res.status(200).json({ status: "OK", timestamp: new Date().toISOString() });
});

// 404 handler - Updated to use modern template
app.use((req, res) => {
  res.status(404).render("404-modern", { title: "Page Not Found" });
});

// Error handler - Updated to use modern template
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).render("500-modern", {
    title: "Server Error",
    message: err.message,
    error: process.env.NODE_ENV === "development" ? err : {},
  });
});

// Direct route for register-modern.html
app.get("/register-modern.html", (req, res) => {
  res.sendFile(path.join(__dirname, "views", "register-modern.html"));
});

let port = Number.parseInt(process.env.PORT) || 3001;

function startServer(port) {
  const server = app.listen(port, () => {
    console.log(`>>> SERVER START: Listening on port ${port}`);
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.log(`Port ${port} is in use, trying port ${port + 1}...`);
      startServer(port + 1); // try next port
    } else {
      console.error(err);
    }
  });
}

startServer(port);
