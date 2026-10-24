const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const { MongoClient, ObjectId, ServerApiVersion } = require("mongodb");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 5000;
const clientUrl = process.env.CLIENT_URL || "http://localhost:3000";

// Ensure uploads directory exists
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
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
    origin: [clientUrl, "http://localhost:3000", "http://127.0.0.1:3000"],
    credentials: true,
  })
);

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

async function initDB() {
  try {
    await client.connect();
    db = client.db("intelli-submit");
    papersCollection = db.collection("papers");
    console.log("Connected to MongoDB Atlas: intelli-submit database");
  } catch (error) {
    console.error("Failed to connect to MongoDB:", error);
  }
}
initDB();

// Root route
app.get("/", (req, res) => {
  res.send({ status: "ok", message: "IntelliSubmit API Server Running" });
});

// Helper: Format file response object
const formatFileInfo = (req, file) => {
  const protocol = req.protocol;
  const host = req.get("host");
  return {
    filename: file.filename,
    originalName: file.originalname,
    mimetype: file.mimetype,
    size: file.size,
    path: file.path,
    url: `${protocol}://${host}/uploads/${file.filename}`,
  };
};

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

    const newPaper = {
      title: title.trim(),
      abstract: abstract.trim(),
      authors: parsedAuthors.length > 0 ? parsedAuthors : [authorName || "Anonymous Author"],
      category: category || "Computer Science / General",
      keywords: parsedKeywords,
      authorEmail: authorEmail || "author@example.com",
      authorName: authorName || "Author",
      file: formatFileInfo(req, req.file),
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
      .find({ authorEmail: email })
      .sort({ updatedAt: -1 })
      .toArray();

    res.json({ success: true, count: papers.length, papers });
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
      const newFile = formatFileInfo(req, req.file);
      const previousFiles = paper.previousFiles || [];
      if (paper.file) {
        previousFiles.push({
          ...paper.file,
          replacedAt: new Date(),
        });
      }
      updateFields.file = newFile;
      updateFields.previousFiles = previousFiles;
    }

    await papersCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: updateFields }
    );

    const updatedPaper = await papersCollection.findOne({ _id: new ObjectId(id) });

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

    const papers = await papersCollection.find(query).sort({ updatedAt: -1 }).toArray();

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
      count: papers.length,
      papers,
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

    const paper = await papersCollection.findOne({ _id: new ObjectId(id) });
    if (!paper) {
      return res.status(404).json({ success: false, error: "Paper not found" });
    }

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

    const updatedPaper = await papersCollection.findOne({ _id: new ObjectId(id) });

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

    const paper = await papersCollection.findOne({ reviewToken: token });
    if (!paper) {
      return res.status(404).json({ success: false, error: "Invalid or expired review link. Please contact the administrator." });
    }

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

    const updatedPaper = await papersCollection.findOne({ _id: paper._id });

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

// Start Express server
app.listen(port, () => {
  console.log(`IntelliSubmit server running on http://localhost:${port}`);
  console.log(`Uploads available at http://localhost:${port}/uploads/`);
});

