const express = require("express");
const session = require("express-session");
const bodyParser = require("body-parser");
const cookieParser = require("cookie-parser");
const path = require("node:path");
const fs = require("node:fs");
const http = require("http");
const https = require("https");
const cors = require('cors');
// app.use(cors...) moved below app initialization
require("dotenv").config();

// Import database configuration
const { pool, initDatabase } = require("./config/db");

const app = express();
app.use(cors({ origin: true, credentials: true }));

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
      // Mark cookies secure whenever HTTPS is active (set dynamically in startServer)
      secure: process.env.HTTPS_ENABLED === "true",
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

// Academic context middleware – adds req.academicYear & req.semester for downstream routes
const academicContext = require('./middleware/academicContext');
app.use(academicContext);


// Active academic year & semester for all dashboards
const {
  getAcademicContext,
  DEFAULT_ACADEMIC_YEAR,
} = require("./config/systemSettings");
app.use(async (req, res, next) => {
  try {
    res.locals.academicContext = await getAcademicContext();
  } catch (e) {
    res.locals.academicContext = {
      academicYear: DEFAULT_ACADEMIC_YEAR,
      semester: "1",
      semesterLabel: "Semester 1",
      semesterRaw: "1",
    };
  }
  next();
});

// Initialize database
initDatabase().catch((err) =>
  console.error("Database initialization error:", err)
);

// Routes
const authRoutes = require("./routes/auth");
const adminRoutes = require("./routes/admin");
const studentRoutes = require("./routes/student");
const { Server } = require("socket.io");
// Server and Socket.io will be created inside startServer to allow port retries without reusing the same server instance.

const parentRoutes = require("./routes/parent");
const teacherRoutes = require("./routes/teacher");
// const coursesRoutes = require("./routes/courses");

app.use("/auth", authRoutes);
app.use("/admin", adminRoutes);
app.use("/student", studentRoutes);
app.use("/teacher", teacherRoutes);
app.use("/parent", parentRoutes);
// app.use("/courses", coursesRoutes);

// Main routes - Updated to use modern templates
app.get("/", async (req, res) => {
  try {
    const [studentCount] = await pool.query(
      "SELECT COUNT(*) as count FROM students WHERE is_active = 1"
    );
    const [teacherCount] = await pool.query(
      "SELECT COUNT(*) as count FROM teachers WHERE is_active = 1"
    );
    const [parentCount] = await pool.query(
      "SELECT COUNT(*) as count FROM parents"
    );
    const [courseCount] = await pool.query(
      "SELECT COUNT(*) as count FROM courses WHERE is_active = 1"
    );
    const [testimonials] = await pool.query(
      `SELECT
         id,
         name,
         role,
         quote,
         rating,
         CONCAT(
           UPPER(LEFT(name, 1)),
           UPPER(LEFT(SUBSTRING_INDEX(name, ' ', -1), 1))
         ) AS initials
       FROM testimonials
       WHERE is_active = 1
       ORDER BY sort_order ASC, created_at DESC, id DESC`
    );

    res.render("index-modern", {
      title: "Student Registration and Management System",
      testimonials,
      stats: {
        students: studentCount[0].count,
        teachers: teacherCount[0].count,
        parents: parentCount[0].count,
        courses: courseCount[0].count,
      },
    });
  } catch (error) {
    console.error("Error fetching stats for homepage:", error);
    res.render("index-modern", {
      title: "Student Registration and Management System",
      testimonials: [],
      stats: { students: 0, teachers: 0, parents: 0, courses: 0 },
    });
  }
});

app.get("/about", async (req, res) => {
  try {
    const [studentCount] = await pool.query(
      "SELECT COUNT(*) as count FROM students WHERE is_active = 1"
    );
    const [teacherCount] = await pool.query(
      "SELECT COUNT(*) as count FROM teachers WHERE is_active = 1"
    );
    const [parentCount] = await pool.query(
      "SELECT COUNT(*) as count FROM parents"
    );
    const [courseCount] = await pool.query(
      "SELECT COUNT(*) as count FROM courses WHERE is_active = 1"
    );

    res.render("about-modern", {
      title: "About Us",
      stats: {
        students: studentCount[0].count,
        teachers: teacherCount[0].count,
        parents: parentCount[0].count,
        courses: courseCount[0].count,
      },
    });
  } catch (error) {
    console.error("Error fetching stats for about page:", error);
    res.render("about-modern", {
      title: "About Us",
      stats: { students: 0, teachers: 0, parents: 0, courses: 0 },
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

// Keep legacy page URLs working for existing navigation and bookmarks.
app.get("/login-modern.html", (req, res) => {
  res.redirect("/auth/login");
});

app.get("/register-modern.html", (req, res) => {
  res.redirect("/auth/register");
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

// ---------------------------------------------------------------------------
// SSL certificate paths (generated by mkcert – run: node scripts/setup-https.js)
// ---------------------------------------------------------------------------
const CERT_DIR = path.join(__dirname, "certs");
const SSL_KEY = path.join(CERT_DIR, "localhost-key.pem");
const SSL_CERT = path.join(CERT_DIR, "localhost.pem");

let port = parseInt(process.env.PORT, 10) || 3003;

// Updated startServer to use HTTPS when certs are present, HTTP otherwise
function startServer(port) {
  const useHttps = fs.existsSync(SSL_KEY) && fs.existsSync(SSL_CERT);

  // Set HTTPS_ENABLED before session middleware reads it (process.env must be
  // set before the server is created so the cookie.secure flag is correct).
  if (useHttps) process.env.HTTPS_ENABLED = "true";

  let server;
  if (useHttps) {
    const sslOptions = {
      key: fs.readFileSync(SSL_KEY),
      cert: fs.readFileSync(SSL_CERT),
    };
    server = https.createServer(sslOptions, app);
    console.log(">>> HTTPS mode: SSL certificates loaded from ./certs/");
  } else {
    server = http.createServer(app);
    console.warn(
      ">>> WARNING: SSL certs not found in ./certs/ — running on plain HTTP.\n" +
      "    Run 'node scripts/setup-https.js' to generate them."
    );
  }

  // HTTP → HTTPS redirect server (listens on port+1)
  if (useHttps) {
    const redirectPort = port + 1;
    http.createServer((req, res) => {
      const host = (req.headers.host || `localhost:${redirectPort}`).replace(
        `:${redirectPort}`,
        `:${port}`
      );
      res.writeHead(301, { Location: `https://${host}${req.url}` });
      res.end();
    }).listen(redirectPort, () =>
      console.log(`>>> HTTP→HTTPS redirect on port ${redirectPort}`)
    );
  }

  const io = new Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
  });
  // Make io accessible in routes for this server instance
  app.set("io", io);

  // Automatic Next-Year transition cron job (checks daily at midnight)
  const cron = require('node-cron');
  cron.schedule('0 0 * * *', async () => {
    try {
      const { getAcademicContext, getNextAcademicYear, setActiveAcademicYear } = require('./config/systemSettings');
      const { setActiveSemester } = require('./config/academicSettings');
      const ctx = await getAcademicContext();

      if (ctx.semester === '2' || ctx.semesterLabel === 'Semester 2') {
        const nextYear = getNextAcademicYear(ctx.academicYear);
        if (nextYear) {
          console.log(`[CRON] Midnight transition triggered. Transitioning from ${ctx.academicYear} Semester 2 -> ${nextYear} Semester 1...`);
          await setActiveAcademicYear(nextYear);
          await setActiveSemester('Semester 1');

          const updatedCtx = await getAcademicContext();
          io.emit('semesterChanged', updatedCtx);
          io.emit('semesterUpdated', updatedCtx);
          io.emit('academicContextUpdated', updatedCtx);
          console.log(`[CRON] Transition completed successfully.`);
        }
      }
    } catch (err) {
      console.error('[CRON] Error during academic year automatic transition:', err);
    }
  });

  // Socket.io connection handling – join role-based rooms
  io.on("connection", (socket) => {
    const { userId, role } = socket.handshake.query || {};

    if (!userId || !role) return;

    if (role === "teacher") socket.join(`teacher_${userId}`);
    if (role === "student") socket.join(`student_${userId}`);
    if (role === "parent") socket.join(`parent_${userId}`);
    if (role === "admin") socket.join(`admin_dashboard`);
  });

  server.listen(port, "0.0.0.0", () => {
    const protocol = useHttps ? "https" : "http";
    console.log(`>>> SERVER START: Listening on ${protocol}://localhost:${port}`);
  });

  server.once("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.log(`Port ${port} is in use, trying port ${port + 1}...`);
      server.close(() => startServer(port + 1));
    } else {
      console.error(err);
    }
  });

}
startServer(port);
