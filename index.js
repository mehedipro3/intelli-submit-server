const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const multer = require("multer");
const { MongoClient, ObjectId, ServerApiVersion } = require("mongodb");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 5000;
const clientUrl = process.env.CLIENT_URL || "http://localhost:3000";

// Ensure uploads directory exists (uses /tmp on Vercel serverless)
const uploadDir = process.env.VERCEL
  ? path.join(os.tmpdir(), "uploads")
  : path.join(__dirname, "uploads");

if (!fs.existsSync(uploadDir)) {
  try {
    fs.mkdirSync(uploadDir, { recursive: true });
  } catch (err) {
    console.error("Failed to create uploadDir:", err);
  }
}

// Multer Storage Configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
    cb(null, `${uniqueSuffix}${ext}`);
  },
});

const fileFilter = (req, file, cb) => {
  const allowedExts = [".pdf", ".doc", ".docx"];
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowedExts.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error("Only .pdf, .doc, and .docx files are allowed!"), false);
  }
};

const upload = multer({
  storage,
  limits: { fileSize: 30 * 1024 * 1024 }, // 30 MB limit
  fileFilter,
});

// Middleware
app.use(
  cors({
    origin: true,
    credentials: true,
  })
);

app.options("*", cors({ origin: true, credentials: true }));

app.use(express.json());

// Serve uploaded files statically with cross-origin headers for iframe embedding
app.use(
  "/uploads",
  (req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    next();
  },
  express.static(uploadDir)
);

// MongoDB Atlas Connection
const mongoUri =
  process.env.MONGODB_URI ||
  "mongodb+srv://intellisubmit:eCovKGRinssfrXBW@cluster0.ee44r.mongodb.net/intelli-submit?retryWrites=true&w=majority&appName=Cluster0";

const client = new MongoClient(mongoUri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

let db;
let papersCollection;
let usersCollection;
let isConnected = false;

async function ensureDb() {
  if (!isConnected || !papersCollection || !usersCollection) {
    await client.connect();
    db = client.db("intelli-submit");
    papersCollection = db.collection("papers");
    usersCollection = db.collection("user");
    isConnected = true;
    console.log("Connected to MongoDB Atlas: intelli-submit database");
  }
}
ensureDb().catch((err) => console.error("Initial MongoDB connect error:", err));

// Middleware to ensure DB connection is ready for serverless requests
app.use(async (req, res, next) => {
  if (req.path === "/") return next();
  try {
    await ensureDb();
    next();
  } catch (err) {
    console.error("MongoDB connection error:", err);
    res.status(500).json({ success: false, error: "Database connection failed" });
  }
});

// Root route
app.get("/", (req, res) => {
  res.send({ status: "ok", message: "IntelliSubmit API Server Running" });
});

// Helper: Format file response object
const formatFileInfo = (req, file, paperId = null) => {
  const host = req.get("host");
  const protocol = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const baseUrl = `${protocol}://${host}`;
  return {
    filename: file.filename,
    originalName: file.originalname,
    mimetype: file.mimetype,
    size: file.size,
    path: file.path,
    url: paperId ? `${baseUrl}/api/papers/${paperId}/file` : `${baseUrl}/uploads/${file.filename}`,
    downloadUrl: paperId ? `${baseUrl}/api/papers/${paperId}/download` : `${baseUrl}/uploads/${file.filename}`,
  };
};

const enrichPaperUrls = (req, paper) => {
  if (!paper) return paper;
  const host = req.get("host");
  const protocol = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const baseUrl = `${protocol}://${host}`;
  const paperId = paper._id ? paper._id.toString() : null;

  if (paper.file && paperId) {
    paper.file.url = `${baseUrl}/api/papers/${paperId}/file`;
    paper.file.downloadUrl = `${baseUrl}/api/papers/${paperId}/download`;
  }
  return paper;
};

/* ========================================================
   FILE SERVING & DOWNLOAD ROUTES (Persistent via MongoDB / Disk)
   ======================================================== */

// GET /api/papers/:id/download - Direct file download with attachment header
app.get("/api/papers/:id/download", async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, error: "Invalid paper ID format" });
    }

    const paper = await papersCollection.findOne({ _id: new ObjectId(id) });
    if (!paper || !paper.file) {
      return res.status(404).json({ success: false, error: "Paper or file not found" });
    }

    const filename = paper.file.originalName || paper.file.filename || "manuscript.pdf";
    const mimetype = paper.file.mimetype || "application/octet-stream";

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(filename)}"`);
    res.setHeader("Content-Type", mimetype);

    // 1. Stored in MongoDB (Buffer or base64 string)
    if (paper.file.data) {
      const buffer = Buffer.isBuffer(paper.file.data)
        ? paper.file.data
        : Buffer.from(paper.file.data, "base64");
      return res.send(buffer);
    }

    // 2. Check local disk
    const diskPath = paper.file.path || path.join(uploadDir, paper.file.filename || "");
    if (diskPath && fs.existsSync(diskPath)) {
      return res.download(diskPath, filename);
    }

    // 3. Fallback redirect
    if (paper.file.url && !paper.file.url.includes("/api/papers/")) {
      return res.redirect(paper.file.url);
    }

    res.status(404).json({ success: false, error: "File data not found on server" });
  } catch (err) {
    console.error("Error downloading paper file:", err);
    res.status(500).json({ success: false, error: "Failed to download file" });
  }
});

// GET /api/papers/:id/file - Stream file inline for in-browser previewer
app.get("/api/papers/:id/file", async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, error: "Invalid paper ID format" });
    }

    const paper = await papersCollection.findOne({ _id: new ObjectId(id) });
    if (!paper || !paper.file) {
      return res.status(404).json({ success: false, error: "Paper or file not found" });
    }

    const filename = paper.file.originalName || paper.file.filename || "manuscript.pdf";
    const mimetype = paper.file.mimetype || "application/pdf";

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(filename)}"`);
    res.setHeader("Content-Type", mimetype);

    if (paper.file.data) {
      const buffer = Buffer.isBuffer(paper.file.data)
        ? paper.file.data
        : Buffer.from(paper.file.data, "base64");
      return res.send(buffer);
    }

    const diskPath = paper.file.path || path.join(uploadDir, paper.file.filename || "");
    if (diskPath && fs.existsSync(diskPath)) {
      return res.sendFile(diskPath);
    }

    if (paper.file.url && !paper.file.url.includes("/api/papers/")) {
      return res.redirect(paper.file.url);
    }

    res.status(404).json({ success: false, error: "File content not found" });
  } catch (err) {
    console.error("Error viewing paper file:", err);
    res.status(500).json({ success: false, error: "Failed to display file" });
  }
});

/* ========================================================
   USER / ROLE MANAGEMENT ROUTES (Admin Portal)
   ======================================================== */

// GET /api/admin/users - Get all users
app.get("/api/admin/users", async (req, res) => {
  try {
    const users = await usersCollection
      .find({}, { projection: { password: 0 } })
      .sort({ createdAt: -1 })
      .toArray();

    const sanitizedUsers = users.map((u) => ({
      _id: u._id,
      name: u.name || "User",
      email: u.email,
      role: u.role || "author",
      image: u.image || null,
      createdAt: u.createdAt || null,
    }));

    res.json({
      success: true,
      count: sanitizedUsers.length,
      users: sanitizedUsers,
    });
  } catch (err) {
    console.error("Error fetching users:", err);
    res.status(500).json({ success: false, error: "Failed to fetch users" });
  }
});

// PATCH /api/admin/users/:id/role - Update a user's role
app.patch("/api/admin/users/:id/role", async (req, res) => {
  try {
    const { id } = req.params;
    const { role } = req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, error: "Invalid user ID format" });
    }

    if (!["author", "reviewer", "admin"].includes(role)) {
      return res.status(400).json({
        success: false,
        error: "Role must be 'author', 'reviewer', or 'admin'",
      });
    }

    const result = await usersCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { role, updatedAt: new Date() } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, error: "User not found" });
    }

    const updatedUser = await usersCollection.findOne(
      { _id: new ObjectId(id) },
      { projection: { password: 0 } }
    );

    res.json({
      success: true,
      message: `User role updated to ${role}`,
      user: updatedUser,
    });
  } catch (err) {
    console.error("Error updating user role:", err);
    res.status(500).json({ success: false, error: "Failed to update user role" });
  }
});

/* ========================================================
   AUTHOR ROUTES: Submit Paper & Manage Author Papers
   ======================================================== */

// POST /api/papers - Submit a new paper
app.post("/api/papers", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: "Paper document file (.pdf, .doc, .docx) is required" });
    }

    const { title, abstract, authors, category, keywords, authorEmail, authorName } = req.body;

    if (!title || !abstract) {
      return res.status(400).json({ success: false, error: "Title and abstract are required" });
    }

    if (!authorEmail || !authorEmail.includes("@")) {
      return res.status(401).json({ success: false, error: "Authentication required: You must be logged in as an author to submit a paper." });
    }

    let parsedAuthors = [];
    if (typeof authors === "string") {
      try {
        parsedAuthors = JSON.parse(authors);
      } catch {
        parsedAuthors = authors.split(",").map((a) => a.trim()).filter(Boolean);
      }
    } else if (Array.isArray(authors)) {
      parsedAuthors = authors;
    }

    let parsedKeywords = [];
    if (typeof keywords === "string") {
      try {
        parsedKeywords = JSON.parse(keywords);
      } catch {
        parsedKeywords = keywords.split(",").map((k) => k.trim()).filter(Boolean);
      }
    } else if (Array.isArray(keywords)) {
      parsedKeywords = keywords;
    }

    // Read file buffer for persistent storage in MongoDB
    let fileBase64 = null;
    if (req.file.path && fs.existsSync(req.file.path)) {
      try {
        fileBase64 = fs.readFileSync(req.file.path).toString("base64");
      } catch (e) {
        console.error("Failed to read file into base64:", e);
      }
    }

    const fileMeta = formatFileInfo(req, req.file);
    if (fileBase64) {
      fileMeta.data = fileBase64;
    }

    const newPaper = {
      title: title.trim(),
      abstract: abstract.trim(),
      authors: parsedAuthors.length > 0 ? parsedAuthors : [authorName || "Anonymous Author"],
      category: category || "Computer Science / General",
      keywords: parsedKeywords,
      authorEmail: authorEmail || "author@example.com",
      authorName: authorName || "Author",
      file: fileMeta,
      status: "Submitted", // Submitted, Under Review, Revision Requested, Resubmitted, Published
      reviewToken: null,
      reviewTokenCreatedAt: null,
      reviewCount: 0,
      reviewHistory: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await papersCollection.insertOne(newPaper);
    newPaper._id = result.insertedId;

    // Attach direct file preview & download URLs
    enrichPaperUrls(req, newPaper);
    delete newPaper.file.data;

    res.status(201).json({
      success: true,
      message: "Paper submitted successfully!",
      paper: newPaper,
    });
  } catch (err) {
    console.error("Error creating paper:", err);
    res.status(500).json({ success: false, error: err.message || "Failed to submit paper" });
  }
});

// GET /api/papers/author - Get papers by author email
app.get("/api/papers/author", async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) {
      return res.status(400).json({ success: false, error: "Author email query parameter is required" });
    }

    const papers = await papersCollection
      .find({ authorEmail: email }, { projection: { "file.data": 0, "previousFiles.data": 0 } })
      .sort({ updatedAt: -1 })
      .toArray();

    const enrichedPapers = papers.map((p) => enrichPaperUrls(req, p));

    res.json({ success: true, count: enrichedPapers.length, papers: enrichedPapers });
  } catch (err) {
    console.error("Error fetching author papers:", err);
    res.status(500).json({ success: false, error: "Failed to fetch papers" });
  }
});

// POST /api/papers/:id/resubmit - Resubmit paper with updated file/notes
app.post("/api/papers/:id/resubmit", upload.single("file"), async (req, res) => {
  try {
    const { id } = req.params;
    const { revisionNotes } = req.body;

    const paper = await papersCollection.findOne({ _id: new ObjectId(id) });
    if (!paper) {
      return res.status(404).json({ success: false, error: "Paper not found" });
    }

    const updateFields = {
      status: "Resubmitted",
      latestRevisionNotes: revisionNotes || "Updated paper submitted per reviewer comments.",
      updatedAt: new Date(),
    };

    if (req.file) {
      let fileBase64 = null;
      if (req.file.path && fs.existsSync(req.file.path)) {
        try {
          fileBase64 = fs.readFileSync(req.file.path).toString("base64");
        } catch (e) {
          console.error("Failed to read resubmit file into base64:", e);
        }
      }

      const newFile = formatFileInfo(req, req.file, id);
      if (fileBase64) {
        newFile.data = fileBase64;
      }

      const previousFiles = paper.previousFiles || [];
      if (paper.file) {
        const archivedFile = { ...paper.file, replacedAt: new Date() };
        delete archivedFile.data;
        previousFiles.push(archivedFile);
      }
      updateFields.file = newFile;
      updateFields.previousFiles = previousFiles;
    }

    await papersCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: updateFields }
    );

    const updatedPaper = await papersCollection.findOne(
      { _id: new ObjectId(id) },
      { projection: { "file.data": 0, "previousFiles.data": 0 } }
    );

    enrichPaperUrls(req, updatedPaper);

    res.json({
      success: true,
      message: "Paper resubmitted successfully!",
      paper: updatedPaper,
    });
  } catch (err) {
    console.error("Error resubmitting paper:", err);
    res.status(500).json({ success: false, error: err.message || "Failed to resubmit paper" });
  }
});

/* ========================================================
   ADMIN ROUTES: List all papers & Generate Review Token URL
   ======================================================== */

// GET /api/papers - Get all papers (with optional status filter)
app.get("/api/papers", async (req, res) => {
  try {
    const { status, search } = req.query;
    const query = {};

    if (status && status !== "All") {
      query.status = status;
    }

    if (search) {
      query.$or = [
        { title: { $regex: search, $options: "i" } },
        { authorName: { $regex: search, $options: "i" } },
        { authorEmail: { $regex: search, $options: "i" } },
        { category: { $regex: search, $options: "i" } },
      ];
    }

    const papers = await papersCollection
      .find(query, { projection: { "file.data": 0, "previousFiles.data": 0 } })
      .sort({ updatedAt: -1 })
      .toArray();

    const enrichedPapers = papers.map((p) => enrichPaperUrls(req, p));

    // Summary counts for dashboard badges
    const totalCount = await papersCollection.countDocuments();
    const submittedCount = await papersCollection.countDocuments({ status: "Submitted" });
    const underReviewCount = await papersCollection.countDocuments({ status: "Under Review" });
    const revisionCount = await papersCollection.countDocuments({ status: "Revision Requested" });
    const resubmittedCount = await papersCollection.countDocuments({ status: "Resubmitted" });
    const publishedCount = await papersCollection.countDocuments({ status: "Published" });

    res.json({
      success: true,
      metrics: {
        total: totalCount,
        submitted: submittedCount,
        underReview: underReviewCount,
        revisionRequested: revisionCount,
        resubmitted: resubmittedCount,
        published: publishedCount,
      },
      count: enrichedPapers.length,
      papers: enrichedPapers,
    });
  } catch (err) {
    console.error("Error fetching all papers:", err);
    res.status(500).json({ success: false, error: "Failed to fetch papers" });
  }
});

// GET /api/papers/:id - Get single paper details
app.get("/api/papers/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, error: "Invalid paper ID format" });
    }

    const paper = await papersCollection.findOne(
      { _id: new ObjectId(id) },
      { projection: { "file.data": 0, "previousFiles.data": 0 } }
    );
    if (!paper) {
      return res.status(404).json({ success: false, error: "Paper not found" });
    }

    enrichPaperUrls(req, paper);

    res.json({ success: true, paper });
  } catch (err) {
    console.error("Error fetching paper:", err);
    res.status(500).json({ success: false, error: "Failed to fetch paper" });
  }
});

// POST /api/papers/:id/generate-token - Admin generates custom reviewer URL
app.post("/api/papers/:id/generate-token", async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, error: "Invalid paper ID format" });
    }

    const paper = await papersCollection.findOne({ _id: new ObjectId(id) });
    if (!paper) {
      return res.status(404).json({ success: false, error: "Paper not found" });
    }

    // Generate unique token (using crypto UUID)
    const token = crypto.randomUUID();
    const reviewUrl = `${clientUrl}/review/${token}`;

    const updateDoc = {
      reviewToken: token,
      reviewTokenCreatedAt: new Date(),
      updatedAt: new Date(),
    };

    // If status is 'Submitted' or 'Resubmitted', move to 'Under Review'
    if (paper.status === "Submitted" || paper.status === "Resubmitted") {
      updateDoc.status = "Under Review";
    }

    await papersCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: updateDoc }
    );

    const updatedPaper = await papersCollection.findOne(
      { _id: new ObjectId(id) },
      { projection: { "file.data": 0, "previousFiles.data": 0 } }
    );
    enrichPaperUrls(req, updatedPaper);

    res.json({
      success: true,
      message: "Review link generated successfully",
      reviewToken: token,
      reviewUrl,
      paper: updatedPaper,
    });
  } catch (err) {
    console.error("Error generating review token:", err);
    res.status(500).json({ success: false, error: "Failed to generate review link" });
  }
});

/* ========================================================
   REVIEWER ROUTES: Access via token & submit review decision
   ======================================================== */

// GET /api/papers/review/:token - Reviewer views paper via secret token
app.get("/api/papers/review/:token", async (req, res) => {
  try {
    const { token } = req.params;
    if (!token) {
      return res.status(400).json({ success: false, error: "Review token is required" });
    }

    const paper = await papersCollection.findOne(
      { reviewToken: token },
      { projection: { "file.data": 0, "previousFiles.data": 0 } }
    );
    if (!paper) {
      return res.status(404).json({
        success: false,
        error: "Invalid or expired review link. Please contact the administrator.",
      });
    }

    enrichPaperUrls(req, paper);

    res.json({ success: true, paper });
  } catch (err) {
    console.error("Error fetching paper by token:", err);
    res.status(500).json({ success: false, error: "Failed to retrieve paper" });
  }
});

// POST /api/papers/review/:token - Reviewer submits review decision (publish / revision)
app.post("/api/papers/review/:token", async (req, res) => {
  try {
    const { token } = req.params;
    const { decision, feedback, reviewerName } = req.body;

    if (!token) {
      return res.status(400).json({ success: false, error: "Review token is required" });
    }

    if (!decision || !["publish", "revision_requested"].includes(decision)) {
      return res.status(400).json({
        success: false,
        error: "Decision must be either 'publish' or 'revision_requested'",
      });
    }

    if (decision === "revision_requested" && (!feedback || feedback.trim().length === 0)) {
      return res.status(400).json({
        success: false,
        error: "Review feedback is required when requesting revisions.",
      });
    }

    const paper = await papersCollection.findOne({ reviewToken: token });
    if (!paper) {
      return res.status(404).json({ success: false, error: "Invalid or expired review link." });
    }

    const currentCount = paper.reviewCount || 0;
    const newRound = currentCount + 1;

    const reviewEntry = {
      round: newRound,
      decision,
      feedback: feedback ? feedback.trim() : "",
      reviewerName: reviewerName || "Peer Reviewer",
      reviewedAt: new Date(),
    };

    let newStatus = "";
    let updatedReviewCount = currentCount;

    if (decision === "publish") {
      newStatus = "Published";
    } else if (decision === "revision_requested") {
      newStatus = "Revision Requested";
      updatedReviewCount = currentCount + 1;
    }

    await papersCollection.updateOne(
      { _id: paper._id },
      {
        $set: {
          status: newStatus,
          reviewCount: updatedReviewCount,
          lastFeedback: feedback ? feedback.trim() : "",
          updatedAt: new Date(),
        },
        $push: {
          reviewHistory: reviewEntry,
        },
      }
    );

    const updatedPaper = await papersCollection.findOne(
      { _id: paper._id },
      { projection: { "file.data": 0, "previousFiles.data": 0 } }
    );
    enrichPaperUrls(req, updatedPaper);

    res.json({
      success: true,
      message:
        decision === "publish"
          ? "Paper successfully approved and marked as Published!"
          : "Review submitted. Revision request sent to the author.",
      paper: updatedPaper,
    });
  } catch (err) {
    console.error("Error submitting review:", err);
    res.status(500).json({ success: false, error: err.message || "Failed to submit review" });
  }
});

// Start Express server (when running locally)
if (process.env.NODE_ENV !== "production" || !process.env.VERCEL) {
  app.listen(port, () => {
    console.log(`IntelliSubmit server running on http://localhost:${port}`);
    console.log(`Uploads available at http://localhost:${port}/uploads/`);
  });
}

module.exports = app;
