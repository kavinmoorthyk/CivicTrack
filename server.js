const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, "data");
const UPLOAD_DIR = path.join(__dirname, "uploads");
const DB_FILE = path.join(DATA_DIR, "issues.json");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(DB_FILE, "[]");
}

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(UPLOAD_DIR));

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOAD_DIR),
  filename: (_, file, cb) => {
    const ext = path.extname(file.originalname)
      .toLowerCase()
      .replace(/[^.a-z0-9]/g, "");

    cb(null, `${Date.now()}-${crypto.randomBytes(5).toString("hex")}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      return cb(new Error("Please upload an image file."));
    }
    cb(null, true);
  }
});

function readIssues() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch {
    return [];
  }
}

function writeIssues(issues) {
  fs.writeFileSync(DB_FILE, JSON.stringify(issues, null, 2));
}

function numberOr(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function distanceMeters(aLat, aLon, bLat, bLon) {
  const rad = x => x * Math.PI / 180;
  const dLat = rad(bLat - aLat);
  const dLon = rad(bLon - aLon);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(aLat)) *
    Math.cos(rad(bLat)) *
    Math.sin(dLon / 2) ** 2;

  return 6371000 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function priorityScore({ severity = 50, reports = 1, ageHours = 0 }) {
  const reportScore = Math.min(100, reports * 25);
  const ageScore = Math.min(100, ageHours * 2);

  return Math.round(
    0.55 * severity +
    0.25 * reportScore +
    0.20 * ageScore
  );
}

function priorityLabel(score) {
  if (score >= 85) return "Critical";
  if (score >= 70) return "High";
  if (score >= 40) return "Medium";
  return "Low";
}

// HEALTH CHECK
app.get("/api/health", (_, res) => {
  res.json({
    ok: true,
    storage: "local-json",
    application: "CivicTrack"
  });
});

// GET ALL COMPLAINTS
app.get("/api/issues", (_, res) => {
  const issues = readIssues().sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );
  res.json(issues);
});

// SUBMIT A COMPLAINT — manual category and description, no AI processing
app.post("/api/issues", upload.single("image"), (req, res) => {
  try {
    const lat = numberOr(req.body.latitude, NaN);
    const lon = numberOr(req.body.longitude, NaN);

    if (!Number.isFinite(lat) || !Number.isFinite(lon) ||
        lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(400).json({
        error: "Choose a valid location on the map or use your device location."
      });
    }

    const category = String(req.body.category || "Other").slice(0, 80);
    const description = String(
      req.body.description || "Submitted for inspection."
    ).trim().slice(0, 500);

    if (!category || !description) {
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(400).json({
        error: "Select a category and enter an issue description."
      });
    }

    const issues = readIssues();

    const imageHash = req.file
      ? crypto.createHash("sha256")
          .update(fs.readFileSync(req.file.path))
          .digest("hex")
      : null;

    // Do not merge real complaints into demo records.
    const duplicate = issues.find(old =>
      !old.demo &&
      old.category === category &&
      distanceMeters(
        lat,
        lon,
        numberOr(old.latitude, 999),
        numberOr(old.longitude, 999)
      ) <= 150
    );

    if (duplicate) {
      duplicate.reportCount = (duplicate.reportCount || 1) + 1;
      duplicate.priorityScore = priorityScore({
        severity: duplicate.severity,
        reports: duplicate.reportCount,
        ageHours:
          (Date.now() - new Date(duplicate.createdAt).getTime()) / 3600000
      });
      duplicate.priority = priorityLabel(duplicate.priorityScore);

      writeIssues(issues);
      if (req.file) fs.unlinkSync(req.file.path);

      return res.status(200).json({
        message: "Similar issue found nearby. Your report was added to the existing issue.",
        issue: duplicate,
        duplicate: true
      });
    }

    const severity = numberOr(req.body.severity, 50);
    const issue = {
      id: crypto.randomUUID(),
      title: `${category} reported`,
      category,
      description,
      latitude: lat,
      longitude: lon,
      address: String(req.body.address || "Location selected on map").slice(0, 180),
      severity,
      reportCount: 1,
      priorityScore: priorityScore({ severity, reports: 1, ageHours: 0 }),
      priority: "",
      status: "Submitted",
      imageUrl: req.file ? `/uploads/${path.basename(req.file.path)}` : null,
      imageHash,
      createdAt: new Date().toISOString()
    };

    issue.priority = priorityLabel(issue.priorityScore);
    issues.push(issue);
    writeIssues(issues);

    res.status(201).json({
      message: "Complaint submitted successfully.",
      issue,
      duplicate: false
    });
  } catch (e) {
    if (req.file && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch {}
    }
    res.status(500).json({
      error: e.message || "Could not save complaint."
    });
  }
});

// UPDATE COMPLAINT STATUS
app.patch("/api/issues/:id/status", (req, res) => {
  const allowed = [
    "Submitted",
    "Verified",
    "Assigned",
    "In Progress",
    "Resolved"
  ];

  if (!allowed.includes(req.body.status)) {
    return res.status(400).json({ error: "Invalid status." });
  }

  const issues = readIssues();
  const issue = issues.find(x => x.id === req.params.id);

  if (!issue) {
    return res.status(404).json({ error: "Complaint not found." });
  }

  issue.status = req.body.status;
  issue.updatedAt = new Date().toISOString();

  writeIssues(issues);
  res.json(issue);
});

// LOAD COIMBATORE DEMO COMPLAINTS
app.post("/api/demo-seed", (_, res) => {
  const issues = readIssues();

  const demoSamples = [
    {
      id: "demo-gandhipuram-pothole",
      category: "Pothole",
      location: "Gandhipuram",
      latitude: 11.0183,
      longitude: 76.9674,
      severity: 92,
      reportCount: 5,
      status: "Verified",
      daysAgo: 1,
      description: "Large pothole affecting traffic near Gandhipuram (demo report)."
    },
    {
      id: "demo-peelamedu-garbage",
      category: "Garbage",
      location: "Peelamedu",
      latitude: 11.0260,
      longitude: 77.0037,
      severity: 65,
      reportCount: 3,
      status: "Assigned",
      daysAgo: 2,
      description: "Garbage accumulation reported near a roadside area in Peelamedu (demo report)."
    },
    {
      id: "demo-rspuram-water",
      category: "Water Leakage",
      location: "RS Puram",
      latitude: 11.0100,
      longitude: 76.9540,
      severity: 95,
      reportCount: 4,
      status: "In Progress",
      daysAgo: 1,
      description: "Possible water pipeline leakage reported in RS Puram (demo report)."
    },
    {
      id: "demo-sing-anallur-light",
      category: "Broken Streetlight",
      location: "Singanallur",
      latitude: 11.0000,
      longitude: 77.0280,
      severity: 38,
      reportCount: 1,
      status: "Submitted",
      daysAgo: 0,
      description: "Streetlight reported as non-functional in Singanallur (demo report)."
    },
    {
      id: "demo-saibaba-drainage",
      category: "Drainage Blockage",
      location: "Saibaba Colony",
      latitude: 11.0230,
      longitude: 76.9460,
      severity: 86,
      reportCount: 4,
      status: "Verified",
      daysAgo: 3,
      description: "Drainage blockage reported near Saibaba Colony (demo report)."
    },
    {
      id: "demo-hopecollege-pothole",
      category: "Pothole",
      location: "Hope College",
      latitude: 11.0255,
      longitude: 77.0120,
      severity: 72,
      reportCount: 2,
      status: "Resolved",
      daysAgo: 5,
      description: "Road surface damage reported near Hope College (demo report)."
    },
    {
      id: "demo-townhall-garbage",
      category: "Garbage",
      location: "Town Hall",
      latitude: 10.9965,
      longitude: 76.9665,
      severity: 55,
      reportCount: 2,
      status: "Submitted",
      daysAgo: 0,
      description: "Waste accumulation reported around Town Hall (demo report)."
    },
    {
      id: "demo-avinashiroad-water",
      category: "Water Leakage",
      location: "Avinashi Road",
      latitude: 11.0170,
      longitude: 76.9870,
      severity: 88,
      reportCount: 3,
      status: "In Progress",
      daysAgo: 2,
      description: "Water leakage reported along Avinashi Road (demo report)."
    }
  ];

  const existingDemoIds = new Set(
    issues.filter(issue => issue.demo).map(issue => issue.id)
  );

  const newSamples = demoSamples
    .filter(sample => !existingDemoIds.has(sample.id))
    .map(sample => {
      const createdAt = new Date(
        Date.now() - sample.daysAgo * 24 * 60 * 60 * 1000
      ).toISOString();

      const score = priorityScore({
        severity: sample.severity,
        reports: sample.reportCount,
        ageHours: sample.daysAgo * 24
      });

      return {
        id: sample.id,
        title: `${sample.category} reported`,
        category: sample.category,
        description: sample.description,
        latitude: sample.latitude,
        longitude: sample.longitude,
        address: `${sample.location}, Coimbatore, Tamil Nadu`,
        severity: sample.severity,
        reportCount: sample.reportCount,
        priorityScore: score,
        priority: priorityLabel(score),
        status: sample.status,
        imageUrl: null,
        demo: true,
        createdAt
      };
    });

  const updatedIssues = [...issues, ...newSamples];
  writeIssues(updatedIssues);

  res.json({
    message: newSamples.length
      ? "Coimbatore sample complaints added successfully."
      : "All sample complaints are already loaded.",
    added: newSamples.length,
    demoCount: updatedIssues.filter(issue => issue.demo).length,
    total: updatedIssues.length
  });
});

// REMOVE ONLY DEMO COMPLAINTS
app.delete("/api/issues/demo", (_, res) => {
  const issues = readIssues();
  const remaining = issues.filter(issue => !issue.demo);
  const removed = issues.length - remaining.length;

  writeIssues(remaining);

  res.json({
    message: "Demo reports cleared. Real complaints were preserved.",
    removed,
    remaining: remaining.length
  });
});

// ERROR HANDLER
app.use((err, _, res, __) => {
  res.status(400).json({
    error: err.message || "Request failed."
  });
});

app.listen(PORT, () => {
  console.log(`CivicTrack running at http://localhost:${PORT}`);
});
