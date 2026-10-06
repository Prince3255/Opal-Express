import express from "express";
import cors from "cors";
import { Server } from "socket.io";
import fs from "fs";
import http from "http";
import dotenv from "dotenv";
import axios from "axios";
import { v2 as cloudinary } from "cloudinary";
import path from "path";
import { BatchClient } from "@speechmatics/batch-client";
import multer from "multer";
import os from "os";

dotenv.config();

const app = express();

const allowedOrigins = [
  "https://opal-three.vercel.app",
  "http://localhost:5173",
];

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    console.error("Blocked CORS origin:", origin);
    return callback(new Error("Not allowed by CORS"));
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ limit: "20mb", extended: true }));

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_NAME,
  api_key: process.env.CLOUDINARY_KEY,
  api_secret: process.env.CLOUDINARY_SECRET,
});

const server = http.createServer(app);

const uploadDirectory = path.join(os.tmpdir(), "opal-uploads");
const socketRecordingDirectory = path.join(
  os.tmpdir(),
  "opal-socket-recordings",
);

fs.mkdirSync(uploadDirectory, { recursive: true });
fs.mkdirSync(socketRecordingDirectory, { recursive: true });

const upload = multer({
  dest: uploadDirectory,
  limits: {
    fileSize: 500 * 1024 * 1024,
  },
});

const smClient = new BatchClient({
  apiKey: process.env.SPEECHMICS_API_KEY,
  appId: process.env.SPEECHMICS_APP_ID,
});

const uploadVideoToCloudinary = (filePath, options) => {
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload_large(filePath, options, (error, result) => {
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    });
  });
};

app.post("/api/upload", upload.single("file"), async (req, res, next) => {
  const filePath = req.file?.path;

  try {
    if (!req.file || !filePath) {
      return res.status(400).json({
        status: 400,
        message: "No video file was received",
      });
    }

    const { userId, clerkId, plan, workspaceId } = req.body;

    if (!userId || !clerkId || !workspaceId) {
      return res.status(400).json({
        status: 400,
        message: "Missing user or workspace information",
      });
    }

    console.log("Direct upload received:", {
      originalName: req.file.originalname,
      size: req.file.size,
      mimeType: req.file.mimetype,
      filePath,
      userId,
      plan,
      workspaceId,
    });

    await axios.post(
      `${process.env.NEXT_API_HOST}/recording/${userId}/processing`,
      {
        filename: req.file.filename,
      },
    );

    const cloudinaryUpload = await uploadVideoToCloudinary(filePath, {
      resource_type: "video",
      public_id: req.file.filename,
      folder: "video-recording-opal",
      chunk_size: 20 * 1024 * 1024,
      eager: [
        {
          width: 1280,
          height: 720,
          crop: "limit",
          quality: "auto",
        },
        {
          width: 854,
          height: 480,
          crop: "limit",
          quality: "auto",
        },
      ],
      eager_async: true,
    });

    console.log("Complete Cloudinary response:", cloudinaryUpload);

    if (!cloudinaryUpload?.secure_url) {
      throw new Error("Cloudinary upload succeeded but secure_url is missing");
    }

    console.log("Direct video uploaded:", cloudinaryUpload.secure_url);

    if (plan === "PRO") {
      const audioRequest = {
        videoUrl: cloudinaryUpload.secure_url,
        clerkId: userId,
        plan,
        workspaceId,
      };

      console.log("Starting transcription with:", {
        hasVideoUrl: Boolean(audioRequest.videoUrl),
        hasClerkId: Boolean(audioRequest.clerkId),
        plan: audioRequest.plan,
        hasWorkspaceId: Boolean(audioRequest.workspaceId),
      });

      axios
        .post("https://opal-express-08so.onrender.com/api/audio", audioRequest)
        .then((response) => {
          console.log("Transcription completed:", response.data);
        })
        .catch((error) => {
          console.error(
            "Background transcription failed:",
            error.response?.data || error.message,
          );
        });
    }

    const completeResponse = await axios.post(
      `${process.env.NEXT_API_HOST}/recording/${userId}/complete`,
      {
        filename: req.file.filename,
        videoUrl: cloudinaryUpload.secure_url,
        videoId: cloudinaryUpload.public_id,
      },
    );

    if (completeResponse.data?.status !== 200) {
      console.error("Recording completion failed:", completeResponse.data);
    }

    return res.status(200).json({
      status: 200,
      message: "File uploaded successfully",
      videoUrl: cloudinaryUpload.secure_url,
    });
  } catch (error) {
    console.error("Direct upload failed:", {
      message: error.message,
      response: error.response?.data,
      stack: error.stack,
    });

    next(error);
  } finally {
    if (filePath) {
      fs.unlink(filePath, (error) => {
        if (error && error.code !== "ENOENT") {
          console.error("Temporary file deletion failed:", error);
        }
      });
    }
  }
});

const transcript = async (audioFile, trial, userId, secureUrl, workspaceId) => {
  try {
    const response = await smClient.transcribe(
      audioFile,
      {
        transcription_config: {
          language: "en",
        },
      },
      "json-v2",
    );

    const transcriptText = response.results
      .map((result) => result.alternatives?.[0]?.content || "")
      .join(" ")
      .trim();

    console.log("Transcript:", transcriptText);

    if (!transcriptText) {
      throw new Error("No transcript generated");
    }

    const aiResponse = await axios.post(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent",
      {
        contents: [
          {
            parts: [
              {
                text: `
Read the transcript below and return valid JSON only.

Required JSON format:
{
  "title": "short accurate title",
  "description": "short summary of the transcript"
}

Do not use Markdown.
Do not wrap the response in backticks.
Do not add any explanation.

Transcript:
${transcriptText}
                `.trim(),
              },
            ],
          },
        ],
      },
      {
        headers: {
          "x-goog-api-key": process.env.GEMINI_API_KEY,
          "Content-Type": "application/json",
        },
      },
    );

    const generatedText =
      aiResponse.data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!generatedText) {
      throw new Error("Gemini returned no title or description");
    }

    const cleanedText = generatedText
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    let generatedContent;

    try {
      generatedContent = JSON.parse(cleanedText);
    } catch (error) {
      console.error("Gemini returned invalid JSON:", generatedText);
      throw new Error("Could not parse Gemini title and description");
    }

    const title = generatedContent.title?.trim() || "Untitled video";

    const description =
      generatedContent.description?.trim() || "No description generated";

    console.log("Generated title:", title);
    console.log("Generated description:", description);

    const result = await axios.post(
      `${process.env.NEXT_API_HOST}/recording/${userId}/transcribe`,
      {
        filename: secureUrl,
        content: {
          title,
          description,
        },
        transcript: transcriptText,
        trial,
        workspaceId,
      },
    );

    if (result.data?.status !== 200) {
      console.error("Failed to save transcript data:", result.data);

      throw new Error("Transcript data was not saved");
    }

    console.log("Transcript, title, and description saved successfully");

    return {
      transcript: transcriptText,
      title,
      description,
    };
  } catch (error) {
    console.error("Transcript processing failed:", {
      message: error.message,
      response: error.response?.data,
      stack: error.stack,
    });

    throw error;
  }
};

app.post("/api/audio", async (req, res) => {
  try {
    const { videoUrl, clerkId, plan, workspaceId } = req.body;

    console.log("Audio request received:", {
      hasVideoUrl: Boolean(videoUrl),
      hasClerkId: Boolean(clerkId),
      plan,
      hasWorkspaceId: Boolean(workspaceId),
    });

    if (!videoUrl || !clerkId || !workspaceId) {
      return res.status(400).json({
        status: 400,
        message: "Missing audio processing data",
        missing: {
          videoUrl: !videoUrl,
          clerkId: !clerkId,
          workspaceId: !workspaceId,
        },
      });
    }

    const audioUrl = videoUrl.replace(/\.(webm|mp4|mov)(\?.*)?$/i, ".mp3");

    const audioResponse = await axios.get(audioUrl, {
      responseType: "arraybuffer",
      maxContentLength: 100 * 1024 * 1024,
      maxBodyLength: 100 * 1024 * 1024,
    });

    const audioFile = new File(
      [audioResponse.data],
      `audio-${Date.now()}.mp3`,
      {
        type: "audio/mpeg",
      },
    );

    await transcript(
      audioFile,
      plan === "FREE",
      clerkId,
      videoUrl,
      workspaceId,
    );

    return res.status(200).json({
      status: 200,
      message: "Transcription completed",
    });
  } catch (error) {
    console.error("Audio processing failed:", {
      message: error.message,
      response: error.response?.data,
      stack: error.stack,
    });

    return res.status(500).json({
      status: 500,
      message: "Audio processing failed",
    });
  }
});

const recordingStreams = new Map();

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true,
  },
  path: "/socket.io",
  transports: ["websocket", "polling"],
});

io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  socket.emit("connected", "hello");

  socket.on("abcd", (message) => {
    console.log("Received abcd:", message);
  });

  socket.on("video-chunks", async ({ chunks, filename }) => {
    try {
      if (!filename || !chunks) {
        return socket.emit("upload-error", {
          message: "Chunk or filename is missing",
        });
      }

      const key = `${socket.id}:${filename}`;

      let recording = recordingStreams.get(key);

      if (!recording) {
        const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "_");

        const filePath = path.join(
          socketRecordingDirectory,
          `${socket.id}-${safeFilename}`,
        );

        const stream = fs.createWriteStream(filePath);

        recording = {
          stream,
          filePath,
        };

        recordingStreams.set(key, recording);

        console.log("Started socket recording:", filePath);
      }

      let buffer;

      if (chunks instanceof ArrayBuffer) {
        buffer = Buffer.from(chunks);
      } else if (ArrayBuffer.isView(chunks)) {
        buffer = Buffer.from(
          chunks.buffer,
          chunks.byteOffset,
          chunks.byteLength,
        );
      } else if (
        chunks &&
        chunks.type === "Buffer" &&
        Array.isArray(chunks.data)
      ) {
        buffer = Buffer.from(chunks.data);
      } else {
        throw new Error("Unsupported chunk format");
      }

      const canContinue = recording.stream.write(buffer);

      if (!canContinue) {
        await new Promise((resolve) => {
          recording.stream.once("drain", resolve);
        });
      }

      socket.emit("chunk-received", {
        filename,
        bytes: buffer.length,
      });
    } catch (error) {
      console.error("Socket chunk write failed:", error);

      socket.emit("upload-error", {
        message: "Failed to save video chunk",
      });
    }
  });

  socket.on("finish-video", async ({ filename }) => {
    const key = `${socket.id}:${filename}`;
    const recording = recordingStreams.get(key);

    if (!recording) {
      return socket.emit("upload-error", {
        message: "Recording file was not found",
      });
    }

    const filePath = recording.filePath;

    try {
      await new Promise((resolve, reject) => {
        recording.stream.end((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });

      console.log("All socket chunks saved:", filePath);

      const cloudinaryUpload = await cloudinary.uploader.upload_large(
        filePath,
        {
          resource_type: "video",
          public_id: filename.replace(/\.[^/.]+$/, ""),
          folder: "video-recording-opal",
          chunk_size: 20 * 1024 * 1024,
          eager: [
            {
              width: 1280,
              height: 720,
              crop: "limit",
              quality: "auto",
            },
            {
              width: 854,
              height: 480,
              crop: "limit",
              quality: "auto",
            },
          ],
          eager_async: true,
        },
      );

      console.log("Electron video uploaded:", cloudinaryUpload.secure_url);

      socket.emit("processing-complete", {
        filename,
        videoUrl: cloudinaryUpload.secure_url,
      });
    } catch (error) {
      console.error("Socket video upload failed:", {
        message: error.message,
        response: error.response?.data,
      });

      socket.emit("upload-error", {
        message: "Failed to upload recorded video",
      });
    } finally {
      recordingStreams.delete(key);

      fs.unlink(filePath, (error) => {
        if (error && error.code !== "ENOENT") {
          console.error("Socket temporary-file deletion failed:", error);
        }
      });
    }
  });

  socket.on("disconnect", (reason) => {
    console.log("Socket disconnected:", socket.id, reason);

    for (const [key, recording] of recordingStreams.entries()) {
      if (key.startsWith(`${socket.id}:`)) {
        recording.stream.destroy();

        fs.unlink(recording.filePath, (error) => {
          if (error && error.code !== "ENOENT") {
            console.error("Interrupted recording cleanup failed:", error);
          }
        });

        recordingStreams.delete(key);
      }
    }
  });
});

app.use((error, req, res, next) => {
  console.error("Unhandled server error:", error);

  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        status: 413,
        message: "Video is too large. Maximum allowed size is 500 MB.",
      });
    }

    return res.status(400).json({
      status: 400,
      message: error.message,
    });
  }

  if (error.message === "Not allowed by CORS") {
    return res.status(403).json({
      status: 403,
      message: "Origin is not allowed",
    });
  }

  return res.status(500).json({
    status: 500,
    message: "Internal server error",
  });
});

const PORT = Number(process.env.PORT) || 5000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on port ${PORT}`);
});
