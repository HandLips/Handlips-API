require("dotenv").config();
const express = require("express");
const { Sequelize, DataTypes } = require("sequelize");
const textToSpeech = require("@google-cloud/text-to-speech");
const { Storage } = require("@google-cloud/storage");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const multer = require("multer");
const cors = require("cors");

// Initialize express app
const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Welcome to the jungle",
    version: "1.0.0",
  });
});
// Health check route
app.get("/health", (req, res) => {
  res.json({
    success: true,
    timestamp: new Date(),
    uptime: process.uptime(),
    status: "healthy",
  });
});

// Database setup with Sequelize
const sequelize = new Sequelize(
  process.env.DB_NAME,
  process.env.DB_USER,
  process.env.DB_PASSWORD,
  {
    host: process.env.DB_HOST,
    dialect: "mysql",
    logging: false,
    pool: {
      max: 10,
      min: 0,
      acquire: 30000,
      idle: 10000,
    },
  }
);

// Model definitions
const Soundboard = sequelize.define("Soundboard", {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  title: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  text: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  audioUrl: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  fileName: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  createdByEmail: {
    type: DataTypes.STRING,
    allowNull: false,
  },
});

// Google Cloud Setup
let storage;
let ttsClient;
let bucket;

try {
  storage = new Storage({
    keyFilename: path.join(__dirname, "gcp-key.json"),
    projectId: process.env.GCP_PROJECT_ID,
  });

  bucket = storage.bucket(process.env.GCP_BUCKET_NAME);

  ttsClient = new textToSpeech.TextToSpeechClient({
    keyFilename: path.join(__dirname, "gcp-key.json"),
  });
} catch (error) {
  console.error("Error initializing Google Cloud services:", error);
}

// Multer configuration for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const allowedMimes = ["image/jpeg", "image/png", "image/jpg"];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("File harus berupa gambar."));
    }
  },
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB
  },
});

// Helper Functions
const generateSpeech = async (text) => {
  try {
    const request = {
      input: { text },
      voice: { languageCode: "id-ID", ssmlGender: "NEUTRAL" },
      audioConfig: { audioEncoding: "MP3" },
    };

    const [response] = await ttsClient.synthesizeSpeech(request);
    return response.audioContent;
  } catch (error) {
    throw new Error(`Error generating speech: ${error.message}`);
  }
};

const uploadToGCS = async (buffer, filename, contentType = "audio/mpeg") => {
  const file = bucket.file(filename);

  try {
    await file.save(buffer, {
      contentType: contentType,
      metadata: {
        cacheControl: "public, max-age=31536000",
      },
    });

    const publicUrl = `https://storage.googleapis.com/${process.env.GCP_BUCKET_NAME}/${filename}`;
    return publicUrl;
  } catch (error) {
    throw new Error(
      `Error uploading to Google Cloud Storage: ${error.message}`
    );
  }
};

// API ROUTES
// API SOUNDBOARDS
app.post("/soundboards", async (req, res) => {
  try {
    const { title, text, email } = req.body;

    if (!title || !text || !email) {
      return res
        .status(400)
        .json({ error: "Title, text, and email are required" });
    }

    const audioBuffer = await generateSpeech(text);

    const fileName = `${uuidv4()}.mp3`;
    const audioUrl = await uploadToGCS(audioBuffer, fileName);

    const soundboard = await Soundboard.create({
      text,
      title,
      audioUrl,
      fileName,
      createdByEmail: email, // Simpan email pengguna
    });

    res.status(201).json({
      success: true,
      message: "Soundboard created successfully",
      data: soundboard,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Failed to create soundboard",
    });
  }
});

app.get("/soundboards/:email", async (req, res) => {
  try {
    const { email } = req.params;

    // Mengambil data soundboard dari database berdasarkan email
    const soundboards = await Soundboard.findAll({
      where: { createdByEmail: email },
      attributes: [
        "id",
        "text",
        "title",
        "audioUrl",
        "fileName",
        "createdByEmail",
        "createdAt",
        "updatedAt",
      ],
      order: [["createdAt", "DESC"]],
    });

    if (soundboards.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No soundboards found for this email",
      });
    }

    // Validasi ketersediaan file di Google Cloud Storage
    const validatedSoundboards = await Promise.all(
      soundboards.map(async (soundboard) => {
        const filename = soundboard.audioUrl.split("/").pop();
        const file = bucket.file(filename);

        try {
          // Memeriksa apakah file ada di Google Cloud Storage
          const [exists] = await file.exists();
          return {
            ...soundboard.toJSON(),
            fileExists: exists, // Menambahkan status ketersediaan file
          };
        } catch (error) {
          console.error(`Error checking file: ${error.message}`);
          return {
            ...soundboard.toJSON(),
            fileExists: false, // Jika ada error, anggap file tidak tersedia
          };
        }
      })
    );

    res.json({
      success: true,
      message: "Soundboards retrieved successfully",
      data: validatedSoundboards,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Failed to fetch soundboards",
    });
  }
});

app.delete("/soundboards/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const soundboard = await Soundboard.findByPk(id);
    if (!soundboard) {
      return res.status(404).json({
        success: false,
        message: "Soundboard not found",
      });
    }

    const filename = soundboard.audioUrl.split("/").pop();
    const file = bucket.file(filename);

    try {
      await file.delete();
    } catch (error) {
      console.error(`Failed to delete file: ${error.message}`);
    }

    await soundboard.destroy();

    res.json({
      success: true,
      message: "Soundboard deleted successfully",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Failed to delete soundboard",
    });
  }
});

// API HISTORY
const History = sequelize.define(
  "History",
  {
    email: {
      type: DataTypes.STRING,
      primaryKey: true,
      allowNull: false,
    },
    id: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    title: {
      type: DataTypes.STRING,
      allowNull: false,
    },
  },
  {
    tableName: "HISTORY",
    timestamps: false,
  }
);

// Define Message model
const Message = sequelize.define(
  "Message",
  {
    message_id: {
      type: DataTypes.STRING,
      primaryKey: true,
      allowNull: false,
    },
    email: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    message: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    created_at: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    is_speech_to_text: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
    },
  },
  {
    tableName: "MESSAGE",
    timestamps: false,
  }
);
// Relations
Message.belongsTo(History, { foreignKey: "email" });

// Route: POST /api/history/email
app.post("/history/email", async (req, res) => {
  try {
    const { email, title } = req.body;

    if (!email || !title) {
      return res.status(400).json({ message: "Email dan title harus diisi" });
    }

    const existingHistory = await History.findOne({ where: { email } });
    if (existingHistory) {
      return res.status(400).json({ message: "Email sudah terdaftar" });
    }

    const id = uuidv4();
    await History.create({
      email,
      id,
      title,
    });

    res.status(201).json({
      message: "Data History berhasil dibuat",
      data: { email, id, title },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Route: POST /api/history/:email
app.post("/history/:email", async (req, res) => {
  try {
    const { email } = req.params;
    const { message, is_speech_to_text } = req.body;

    if (!message || is_speech_to_text === undefined) {
      return res
        .status(400)
        .json({ message: "Message dan is_speech_to_text harus diisi" });
    }

    const existingHistory = await History.findOne({ where: { email } });
    if (!existingHistory) {
      return res
        .status(404)
        .json({ message: `History dengan email ${email} tidak ditemukan` });
    }

    const message_id = uuidv4();
    const created_at = new Date();
    await Message.create({
      message_id,
      email,
      message,
      created_at,
      is_speech_to_text,
    });

    res.status(201).json({
      message: "Data Message berhasil dibuat",
      data: { message_id, email, message, created_at, is_speech_to_text },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Route: GET /api/data/:email
app.get("/history/:email", async (req, res) => {
  try {
    const { email } = req.params;

    const history = await History.findOne({ where: { email } });
    if (!history) {
      return res
        .status(404)
        .json({ message: `History dengan email ${email} tidak ditemukan` });
    }

    const messages = await Message.findAll({ where: { email } });

    res.json({
      message: "Data ditemukan",
      data: {
        history,
        messages,
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Route: DELETE /api/history/:email
app.delete("/history/:email", async (req, res) => {
  try {
    const { email } = req.params;

    const history = await History.findOne({ where: { email } });
    if (!history) {
      return res
        .status(404)
        .json({ message: `History dengan email ${email} tidak ditemukan` });
    }

    await Message.destroy({ where: { email } });
    await History.destroy({ where: { email } });

    res.json({
      message: `History dan message dengan email ${email} telah dihapus`,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// API PROFILE
app.post("/profile", async (req, res) => {
  try {
    const { name, email } = req.body;

    if (!name || !email) {
      return res.status(400).json({
        success: false,
        message: "Name and email are required",
      });
    }

    const existingProfile = await sequelize.query(
      "SELECT * FROM profile WHERE email = ?",
      {
        replacements: [email],
        type: Sequelize.QueryTypes.SELECT,
      }
    );

    if (existingProfile.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Email already exists",
      });
    }

    await sequelize.query("INSERT INTO profile (name, email) VALUES (?, ?)", {
      replacements: [name, email],
      type: Sequelize.QueryTypes.INSERT,
    });

    res.status(201).json({
      success: true,
      message: "Profile created successfully",
      data: { name, email },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

app.get("/profile/:email", async (req, res) => {
  try {
    const { email } = req.params;

    const [profile] = await sequelize.query(
      "SELECT * FROM profile WHERE email = ?",
      {
        replacements: [email],
        type: Sequelize.QueryTypes.SELECT,
      }
    );

    if (!profile) {
      return res.status(404).json({
        success: false,
        message: "Profile not found",
      });
    }

    res.json({
      success: true,
      data: profile,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

app.put(
  "/profile/:email",
  upload.single("profile_picture"),
  async (req, res) => {
    try {
      const { email } = req.params;
      const { name } = req.body;

      if (!name) {
        return res.status(400).json({
          success: false,
          message: "Name is required",
        });
      }

      let profilePictureUrl = null;

      // Jika ada file gambar
      if (req.file) {
        const filename = `profiles/${Date.now()}-${req.file.originalname}`;
        profilePictureUrl = await uploadToGCS(
          req.file.buffer,
          filename,
          req.file.mimetype
        );
      }

      const updateQuery = profilePictureUrl
        ? "UPDATE profile SET name = ?, profile_picture_url = ? WHERE email = ?"
        : "UPDATE profile SET name = ? WHERE email = ?";

      const replacements = profilePictureUrl
        ? [name, profilePictureUrl, email]
        : [name, email];

      const [result] = await sequelize.query(updateQuery, {
        replacements,
        type: Sequelize.QueryTypes.UPDATE,
      });

      if (result === 0) {
        return res.status(404).json({
          success: false,
          message: "Profile not found",
        });
      }

      res.json({
        success: true,
        message: "Profile updated successfully",
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error.message,
      });
    }
  }
);

// API FEEDBACK
app.post("/feedback", async (req, res) => {
  try {
    const { comment, rating } = req.body;

    if (!comment || !rating) {
      return res.status(400).json({
        success: false,
        message: "Rating harus diisi",
      });
    }

    if (rating < 1 || rating > 4) {
      return res.status(400).json({
        success: false,
        message: "Rating harus antara 1-4",
      });
    }

    const [result] = await sequelize.query(
      "INSERT INTO feedback (comment, rating) VALUES (?, ?)",
      {
        replacements: [comment, rating],
        type: Sequelize.QueryTypes.INSERT,
      }
    );

    res.status(201).json({
      success: true,
      data: {
        id: result,
        comment,
        rating,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

//API REPORT
// Model definitions
const Report = sequelize.define(
  "Report",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    comment: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
  },
  {
    timestamps: true, // Menambahkan createdAt dan updatedAt otomatis
  }
);

// POST /report - Membuat report baru
app.post("/report", async (req, res) => {
  try {
    const { comment } = req.body;

    if (!comment) {
      return res.status(400).json({
        success: false,
        message: "Comment harus diisi",
      });
    }

    const report = await Report.create({ comment });

    res.status(201).json({
      success: true,
      data: {
        id: report.id,
        comment: report.comment,
        createdAt: report.createdAt,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// GET /report - Mendapatkan semua report dengan pagination
app.get("/report", async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query; // Query pagination
    const offset = (page - 1) * limit;

    const { count, rows: reports } = await Report.findAndCountAll({
      limit: parseInt(limit),
      offset: parseInt(offset),
      order: [["createdAt", "DESC"]],
    });

    res.json({
      success: true,
      total: count,
      currentPage: parseInt(page),
      totalPages: Math.ceil(count / limit),
      data: reports,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    success: false,
    message: err.message,
  });
});

// Server & Database Initialization
const PORT = process.env.PORT || 3000;

const start = async () => {
  try {
    // Sync database
    await sequelize.sync();
    console.log("Database synced successfully");

    // Start server
    app.listen(PORT, () => {
      console.log(`Server berjalan di port ${PORT}`);
      console.log(`Test API at: http://localhost:${PORT}`);
      console.log("\nAvailable routes:");
      console.log("- POST   /soundboards");
      console.log("- GET    /soundboards");
      console.log("- POST   /history");
      console.log("- GET    /history");
      console.log("- GET    /history/:id");
      console.log("- GET    /profile");
      console.log("- PUT    /profile");
      console.log("- POST   /feedback");
    });
  } catch (error) {
    console.error("Unable to start server:", error);
    process.exit(1);
  }
};

start();
