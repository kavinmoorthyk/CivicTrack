
require("dotenv").config();

const express = require("express");
const multer = require("multer");
const path = require("path");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3000;
const BUCKET = process.env.SUPABASE_BUCKET || "issue-photos";

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SECRET_KEY in environment.");
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  }
);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      return cb(new Error("Please upload an image file."));
    }
    cb(null, true);
  }
});

// ==========================================
// HELPER FUNCTIONS
// ==========================================

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

  return 6371000 * 2 *
    Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function priorityScore({
  severity = 50,
  reports = 1,
  ageHours = 0
}) {
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

function toApiIssue(row) {
  const score = numberOr(
    row.priority_score ?? row.priority,
    0
  );

  return {
    id: row.id,
    title: row.title,
    category: row.category,
    description: row.description,
    latitude: row.latitude,
    longitude: row.longitude,
    address: row.address,
    severity: row.severity,
    reportCount: row.report_count,
    priorityScore: score,
    priority: priorityLabel(score),
    status: row.status || "Submitted",
    imageUrl: row.image_url || null,
    imageHash: row.image_hash || null,
    demo: Boolean(row.demo),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function sendDbError(res, error, fallback) {
  console.error(fallback, error);

  return res.status(500).json({
    error: error?.message || fallback
  });
}

// ==========================================
// IMAGE UPLOAD TO SUPABASE STORAGE
// ==========================================

async function uploadIssuePhoto(file) {
  if (!file) {
    return {
      imageUrl: null,
      imageHash: null
    };
  }

  const extByType = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif"
  };

  const extension = extByType[file.mimetype] || "img";

  const fileName =
    `${Date.now()}-${crypto.randomBytes(8).toString("hex")}.${extension}`;

  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload(fileName, file.buffer, {
      contentType: file.mimetype,
      upsert: false
    });

  if (uploadError) {
    throw uploadError;
  }

  const { data } = supabase.storage
    .from(BUCKET)
    .getPublicUrl(fileName);

  return {
    imageUrl: data.publicUrl,
    imageHash: crypto
      .createHash("sha256")
      .update(file.buffer)
      .digest("hex")
  };
}

// ==========================================
// 1. HEALTH CHECK
// ==========================================

app.get("/api/health", (_, res) => {
  res.json({
    ok: true,
    storage: "supabase",
    application: "CivicTrack"
  });
});

// ==========================================
// 2. GET ALL COMPLAINTS
// ==========================================

app.get("/api/issues", async (_, res) => {
  try {
    const { data, error } = await supabase
      .from("issues")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      return sendDbError(
        res,
        error,
        "Could not load reports."
      );
    }

    res.json((data || []).map(toApiIssue));

  } catch (error) {
    sendDbError(res, error, "Could not load reports.");
  }
});

// ==========================================
// 3. SUBMIT A COMPLAINT
// No AI processing
// ==========================================

app.post(
  "/api/issues",
  upload.single("image"),
  async (req, res) => {
    try {
      const lat = numberOr(req.body.latitude, NaN);
      const lon = numberOr(req.body.longitude, NaN);

      if (
        !Number.isFinite(lat) ||
        !Number.isFinite(lon) ||
        lat < -90 ||
        lat > 90 ||
        lon < -180 ||
        lon > 180
      ) {
        return res.status(400).json({
          error: "Choose a valid location on the map or use your device location."
        });
      }

      const category = String(
        req.body.category || "Other"
      ).trim().slice(0, 80);

      const description = String(
        req.body.description || "Submitted for inspection."
      ).trim().slice(0, 500);

      if (!category || !description) {
        return res.status(400).json({
          error: "Select a category and enter an issue description."
        });
      }

      // Find nearby reports in the same category.
      // Demo reports are excluded.

      const { data: nearbyCandidates, error: findError } =
        await supabase
          .from("issues")
          .select("*")
          .eq("category", category)
          .eq("demo", false);

      if (findError) {
        return sendDbError(
          res,
          findError,
          "Could not check nearby reports."
        );
      }

      const duplicateRow = (nearbyCandidates || []).find(old =>
        Number.isFinite(Number(old.latitude)) &&
        Number.isFinite(Number(old.longitude)) &&
        distanceMeters(
          lat,
          lon,
          Number(old.latitude),
          Number(old.longitude)
        ) <= 150
      );

      // If a nearby issue already exists,
      // increase its report count.

      if (duplicateRow) {
        const reportCount =
          numberOr(duplicateRow.report_count, 1) + 1;

        const ageHours =
          (Date.now() -
            new Date(duplicateRow.created_at).getTime()) /
          3600000;

        const score = priorityScore({
          severity: numberOr(duplicateRow.severity, 50),
          reports: reportCount,
          ageHours: Math.max(0, ageHours)
        });

        const { data: updated, error: updateError } =
          await supabase
            .from("issues")
            .update({
              report_count: reportCount,
              priority: score,
              priority_score: score,
              updated_at: new Date().toISOString()
            })
            .eq("id", duplicateRow.id)
            .select("*")
            .single();

        if (updateError) {
          return sendDbError(
            res,
            updateError,
            "Could not update nearby report."
          );
        }

        return res.status(200).json({
          message:
            "Similar issue found nearby. Your report was added to the existing issue.",
          issue: toApiIssue(updated),
          duplicate: true
        });
      }

      // Create a new complaint.

      const severity = Math.max(
        0,
        Math.min(100, numberOr(req.body.severity, 50))
      );

      const score = priorityScore({
        severity,
        reports: 1,
        ageHours: 0
      });

      const photo = await uploadIssuePhoto(req.file);

      const insertRow = {
        title: `${category} reported`,
        category,
        description,
        latitude: lat,
        longitude: lon,
        address: String(
          req.body.address || "Location selected on map"
        ).slice(0, 180),
        severity,
        report_count: 1,
        priority: score,
        priority_score: score,
        status: "Submitted",
        image_url: photo.imageUrl,
        image_hash: photo.imageHash,
        demo: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      const { data: inserted, error: insertError } =
        await supabase
          .from("issues")
          .insert(insertRow)
          .select("*")
          .single();

      if (insertError) {
        return sendDbError(
          res,
          insertError,
          "Could not save complaint."
        );
      }

      res.status(201).json({
        message: "Complaint submitted successfully.",
        issue: toApiIssue(inserted),
        duplicate: false
      });

    } catch (error) {
      console.error("Complaint submission error:", error);

      res.status(500).json({
        error: error.message || "Could not save complaint."
      });
    }
  }
);

// ==========================================
// 4. UPDATE COMPLAINT STATUS
// ==========================================

app.patch("/api/issues/:id/status", async (req, res) => {
  const allowed = [
    "Submitted",
    "Verified",
    "Assigned",
    "In Progress",
    "Resolved"
  ];

  if (!allowed.includes(req.body.status)) {
    return res.status(400).json({
      error: "Invalid status."
    });
  }

  try {
    const { data, error } = await supabase
      .from("issues")
      .update({
        status: req.body.status,
        updated_at: new Date().toISOString()
      })
      .eq("id", req.params.id)
      .select("*")
      .maybeSingle();

    if (error) {
      return sendDbError(
        res,
        error,
        "Status update failed."
      );
    }

    if (!data) {
      return res.status(404).json({
        error: "Complaint not found."
      });
    }

    res.json(toApiIssue(data));

  } catch (error) {
    sendDbError(res, error, "Status update failed.");
  }
});

// ==========================================
// 5. LOAD COIMBATORE DEMO COMPLAINTS
// ==========================================

app.post("/api/demo-seed", async (_, res) => {
  const demoSamples = [
    {
      category: "Pothole",
      location: "Gandhipuram",
      latitude: 11.0183,
      longitude: 76.9674,
      severity: 92,
      reportCount: 5,
      status: "Verified",
      daysAgo: 1,
      description:
        "Large pothole affecting traffic near Gandhipuram (demo report)."
    },
    {
      category: "Garbage",
      location: "Peelamedu",
      latitude: 11.0260,
      longitude: 77.0037,
      severity: 65,
      reportCount: 3,
      status: "Assigned",
      daysAgo: 2,
      description:
        "Garbage accumulation reported near a roadside area in Peelamedu (demo report)."
    },
    {
      category: "Water Leakage",
      location: "RS Puram",
      latitude: 11.0100,
      longitude: 76.9540,
      severity: 95,
      reportCount: 4,
      status: "In Progress",
      daysAgo: 1,
      description:
        "Possible water pipeline leakage reported in RS Puram (demo report)."
    },
    {
      category: "Broken Streetlight",
      location: "Singanallur",
      latitude: 11.0000,
      longitude: 77.0280,
      severity: 38,
      reportCount: 1,
      status: "Submitted",
      daysAgo: 0,
      description:
        "Streetlight reported as non-functional in Singanallur (demo report)."
    },
    {
      category: "Drainage Blockage",
      location: "Saibaba Colony",
      latitude: 11.0230,
      longitude: 76.9460,
      severity: 86,
      reportCount: 4,
      status: "Verified",
      daysAgo: 3,
      description:
        "Drainage blockage reported near Saibaba Colony (demo report)."
    },
    {
      category: "Pothole",
      location: "Hope College",
      latitude: 11.0255,
      longitude: 77.0120,
      severity: 72,
      reportCount: 2,
      status: "Resolved",
      daysAgo: 5,
      description:
        "Road surface damage reported near Hope College (demo report)."
    },
    {
      category: "Garbage",
      location: "Town Hall",
      latitude: 10.9965,
      longitude: 76.9665,
      severity: 55,
      reportCount: 2,
      status: "Submitted",
      daysAgo: 0,
      description:
        "Waste accumulation reported around Town Hall (demo report)."
    },
    {
      category: "Water Leakage",
      location: "Avinashi Road",
      latitude: 11.0170,
      longitude: 76.9870,
      severity: 88,
      reportCount: 3,
      status: "In Progress",
      daysAgo: 2,
      description:
        "Water leakage reported along Avinashi Road (demo report)."
    }
  ];

  try {
    const { data: existing, error: existingError } =
      await supabase
        .from("issues")
        .select("description")
        .eq("demo", true);

    if (existingError) {
      return sendDbError(
        res,
        existingError,
        "Could not check demo reports."
      );
    }

    const existingDescriptions = new Set(
      (existing || []).map(row => row.description)
    );

    const newRows = demoSamples
      .filter(sample =>
        !existingDescriptions.has(sample.description)
      )
      .map(sample => {
        const createdAt = new Date(
          Date.now() - sample.daysAgo * 86400000
        ).toISOString();

        const score = priorityScore({
          severity: sample.severity,
          reports: sample.reportCount,
          ageHours: sample.daysAgo * 24
        });

        return {
          title: `${sample.category} reported`,
          category: sample.category,
          description: sample.description,
          latitude: sample.latitude,
          longitude: sample.longitude,
          address: `${sample.location}, Coimbatore, Tamil Nadu`,
          severity: sample.severity,
          report_count: sample.reportCount,
          priority: score,
          priority_score: score,
          status: sample.status,
          image_url: null,
          image_hash: null,
          demo: true,
          created_at: createdAt,
          updated_at: createdAt
        };
      });

    if (newRows.length) {
      const { error: insertError } = await supabase
        .from("issues")
        .insert(newRows);

      if (insertError) {
        return sendDbError(
          res,
          insertError,
          "Could not load demo reports."
        );
      }
    }

    const { count, error: countError } = await supabase
      .from("issues")
      .select("id", { count: "exact", head: true });

    if (countError) {
      return sendDbError(
        res,
        countError,
        "Could not count reports."
      );
    }

    const { count: demoCount, error: demoCountError } =
      await supabase
        .from("issues")
        .select("id", { count: "exact", head: true })
        .eq("demo", true);

    if (demoCountError) {
      return sendDbError(
        res,
        demoCountError,
        "Could not count demo reports."
      );
    }

    res.json({
      message: newRows.length
        ? "Coimbatore sample complaints added successfully."
        : "All sample complaints are already loaded.",
      added: newRows.length,
      demoCount: demoCount || 0,
      total: count || 0
    });

  } catch (error) {
    sendDbError(
      res,
      error,
      "Could not load demo reports."
    );
  }
});

// ==========================================
// 6. REMOVE ONLY DEMO COMPLAINTS
// ==========================================

app.delete("/api/issues/demo", async (_, res) => {
  try {
    const { data, error } = await supabase
      .from("issues")
      .delete()
      .eq("demo", true)
      .select("id");

    if (error) {
      return sendDbError(
        res,
        error,
        "Could not remove demo reports."
      );
    }

    res.json({
      message: "Demo reports cleared. Real complaints were preserved.",
      removed: (data || []).length,
      remaining: "Real complaints were preserved."
    });

  } catch (error) {
    sendDbError(
      res,
      error,
      "Could not remove demo reports."
    );
  }
});

// ==========================================
// 7. ERROR HANDLER
// ==========================================

app.use((err, _, res, __) => {
  res.status(400).json({
    error: err.message || "Request failed."
  });
});

// ==========================================
// START SERVER
// ==========================================

app.listen(PORT, () => {
  console.log(`CivicTrack running on port ${PORT}`);
});
