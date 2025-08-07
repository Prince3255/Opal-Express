import express from "express";
import cors from "cors";
import { Server } from "socket.io";
import fs from "fs";
import http from "http";
import dotenv from "dotenv";
import { Readable } from "stream";
import axios from "axios";
import { v2 as cloudinary } from "cloudinary";
import path from "path";
import { BatchClient } from "@speechmatics/batch-client";
import Ffmpeg from "fluent-ffmpeg";
import FfmpegInstaller from "@ffmpeg-installer/ffmpeg";
import multer from "multer";
import os from "os";

dotenv.config();
Ffmpeg.setFfmpegPath(FfmpegInstaller.path);

const app = express();
// app.use(express.static('public'))
app.use(
  cors({
    origin: ["https://opal-three.vercel", "http://localhost:5173"],
  })
);
const upload = multer({
  dest: os.tmpdir(),
  limits: {
    fileSize: 50 * 1024 * 1024,
  },
});
app.post("/api/upload", upload.single("file"), async (req, res) => {
  let filePath = req?.file?.path;
  try {
    const { userId, clerkId, plan, workspaceId } = req.body;
    const processing = await axios.post(
      `${process.env.NEXT_API_HOST}/recording/${userId}/processing`,
      {
        filename: req.file.filename,
      }
    );

    const uploadFile = await cloudinary.uploader.upload(filePath, {
      resource_type: "video",
      public_id: req.file.filename.replace(/\.[^/.]+$/, ""),
      folder: "video-recording-opal",
      chunk_size: 8000000,
      eager: [
        { width: 1280, height: 720, crop: "limit", quality: "auto" },
        { width: 854, height: 480, crop: "limit", quality: "auto" },
      ],
      eager_async: true,
    });

    if (uploadFile) {
      console.log("🟢 Video uploaded to Cloudinary:", uploadFile.secure_url);

      if (plan === "PRO") {
        const transcribe = await axios.post("http://localhost:5000/api/audio", {
          videoUrl: uploadFile.secure_url,
          clerkId: userId,
          plan: plan,
          workspaceId: workspaceId,
        });

        if (transcribe.ok) {
          console.log("🟢 Transcription completed");
        }
      }

      const stopProcessing = await axios.post(
        `${process.env.NEXT_API_HOST}/recording/${userId}/complete`,
        {
          filename: req.file.filename,
          videoUrl: uploadFile.secure_url,
          videoId: uploadFile.public_id,
        }
      );

      if (stopProcessing.data.status !== 200) {
        console.log(
          "Error: Something went wrong when stopping the process and try to complete the processing stage"
        );
      }

      return res.json({ status: 200, message: "File uploaded successfully" });
    }
  } catch (error) {
    console.log("Error while uploading", error);
    return res.json({ status: 500, message: "Something went wrong" });
  } finally {
    fs.unlinkSync(filePath);
  }
});

app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ limit: "20mb", extended: true }));

const smClient = new BatchClient({
  apiKey: process.env.SPEECHMICS_API_KEY,
  appId: process.env.SPEECHMICS_APP_ID,
});

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_NAME,
  api_key: process.env.CLOUDINARY_KEY,
  api_secret: process.env.CLOUDINARY_SECRET,
});

const server = http.createServer(app);

const transcript = async (
  audioFile,
  trial,
  userId,
  secure_url,
  workspaceId
) => {
  const response = await smClient.transcribe(
    audioFile,
    { transcription_config: { language: "en" } },
    "json-v2"
  );

  const transcript = response.results
    .map((r) => r.alternatives[0].content)
    .join(" ");

  console.log("📝 Transcript:", transcript);

  if (transcript) {
    const description = await axios.post(
      "https://api-inference.huggingface.co/models/philschmid/bart-large-cnn-samsum",
      { inputs: transcript },
      {
        headers: {
          Authorization: `Bearer ${process.env.HUGGINGFACE_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );
    const titlePrompt = `Based strictly on the transcript below, create a short and accurate title that summarizes the main topic.

Transcript: "${transcript}"`;
    const titleRes = await axios.post(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent",
      {
        contents: [
          {
            parts: [
              {
                text: `Generate one single, catchy and creative title for this ${transcript}. Return only the title with no explanation or list, just the title itself.`,
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
      }
    );

    let title = titleRes.data.candidates[0].content.parts[0].text;
    const match = title.match(/^\s*\*\s*(.+)$/m);
    title = match ? match[1].trim() : title.trim();

    console.log("📋 Title:", title);
    let titleAndSummaryGenerated = null;
    if (trial) {
      titleAndSummaryGenerated = await axios.post(
        `${process.env.NEXT_API_HOST}/recording/${userId}/transcribe`,
        {
          filename: secure_url,
          content: {
            title: title || "Generate a title",
            description:
              description.data[0].summary_text || "Generate a summary",
          },
          transcript: transcript,
          trial: trial,
          workspaceId: workspaceId,
        }
      );
    } else {
      titleAndSummaryGenerated = await axios.post(
        `${process.env.NEXT_API_HOST}/recording/${userId}/transcribe`,
        {
          filename: secure_url,
          content: {
            title: title || "Generate a title",
            description:
              description.data[0].summary_text || "Generate a summary",
          },
          transcript: transcript,
          trial: trial,
          workspaceId: workspaceId,
        }
      );
    }

    if (titleAndSummaryGenerated?.data?.status !== 200) {
      console.log(
        "Error: Something went wrong with creating the title and description"
      );
    }
  } else {
    console.log("Error: No transcript generated");
  }
};

app.post("/api/audio", async (req, res) => {
  try {
    const { videoUrl, clerkId, plan, workspaceId } = await req.body;

    const audioUrl = videoUrl.replace(".webm", ".mp3");

    const audioFile = await axios.get(audioUrl, {
      responseType: "arraybuffer",
    });

    const audioBuffer = audioFile.data;

    const file = new File(
      [audioBuffer],
      `audio-${Math.ceil(Math.random() * 99999 + Math.random() * 55558)}.mp3`,
      {
        type: "audio/mpeg",
      }
    );

    if (file) {
      if (plan === "FREE") {
        await transcript(file, true, clerkId, videoUrl, workspaceId);
      } else {
        await transcript(file, false, clerkId, videoUrl, workspaceId);
      }
    } else {
      console.log("Error while getting transcript");
    }

    return res.status(200).json({ data: "Video uploaded successfully" });
  } catch (error) {
    console.log("Error in getting video url");
    return res.status(500).json({ data: "Error in getting video url" });
  }
});

const io = new Server(server, {
  cors: {
    origin: ["http://localhost:5173", "http://localhost:3000"],
    methods: ["GET", "POST"],
    credentials: true,
    allowedHeaders: ["Content-Type"],
  },
  path: "/socket.io",
  transports: ["websocket", "polling"],
});

let recorderChunks = [];

io.on("connection", (socket) => {
  console.log("Socket is connected");
  socket.emit("connected", "helo");

  socket.on("abcd", (arg) => {
    console.log(arg);
  });

  socket.on("video-chunks", async ({ chunks, filename }) => {
    try {
      recorderChunks.push(chunks);
      const writeStream = fs.createWriteStream(
        path.join(os.tmpdir(), filename)
      );
      const videoBlob = new Blob(recorderChunks, {
        type: "video/webm; codecs=vp9",
      });
      const buffer = Buffer.from(await videoBlob.arrayBuffer());
      const readStream = Readable.from(buffer);

      readStream.pipe(writeStream);

      writeStream.on("finish", () => {
        console.log("🟢 Chunk saved for:", filename);
      });

      writeStream.on("error", (error) => {
        console.error("🔴 Error saving chunk:", error);
        socket.emit("upload-error", { message: "Failed to save video chunk" });
      });
    } catch (error) {
      console.log("Error in video chunk ", error);
    }
  });

  socket.on("process-video", async (data) => {
    console.log("Processing video ", data);
    recorderChunks = [];

    // Fixed: Use correct path for file reading
    const filePath = path.join(os.tmpdir(), data.filename);
    const audioPath = path.join(os.tmpdir(), data.filename + ".wav");
    let plan = "FREE";
    try {
      const processing = await axios.post(
        `${process.env.NEXT_API_HOST}/recording/${data.userId}/processing`,
        {
          filename: data.filename,
        }
      );

      if (processing.data.status !== 200) {
        return console.log(
          "Error: Something went wrong with creating the processing file"
        );
      }

      // Upload to Cloudinary
      const uploadFile = await cloudinary.uploader.upload(filePath, {
        resource_type: "video",
        public_id: data.filename.replace(/\.[^/.]+$/, ""),
        folder: "video-recording-opal",
        chunk_size: 8000000,
        eager: [
          { width: 1280, height: 720, crop: "limit", quality: "auto" },
          { width: 854, height: 480, crop: "limit", quality: "auto" },
        ],
        eager_async: true,
      });

      if (uploadFile) {
        console.log("🟢 Video uploaded to Cloudinary:", uploadFile.secure_url);
      }

      plan = processing?.data?.plan;
      let workspaceId = processing?.data?.workspaceId;
      // Process transcription for PRO users
      if (processing.data.plan === "PRO") {
        try {
          // await new Promise((resolve, reject) => {
          //   Ffmpeg(filePath)
          //     .noVideo()
          //     .audioCodec("pcm_s16le")
          //     .audioChannels(1)
          //     .audioFrequency(16000)
          //     .on("end", () => {
          //       console.log("audio extracted: ", audioPath);
          //       resolve();
          //     })
          //     .on("error", (err) => {
          //       console.log("audio extraction failed: ", err);
          //       reject(err);
          //     })
          //     .save(audioPath);
          // });

          // const audioBuffer = await fs.promises.readFile(audioPath);
          // const audioFile = new File([audioBuffer], path.basename(audioPath));
          const audioUrl = uploadFile.secure_url.replace(".webm", ".mp3");

          const audioFile = await axios.get(audioUrl, {
            responseType: "arraybuffer",
          });
      
          const audioBuffer = audioFile.data;
      
          const file = new File(
            [audioBuffer],
            `audio-${Math.ceil(Math.random() * 99999 + Math.random() * 55558)}.mp3`,
            {
              type: "audio/mpeg",
            }
          );
          if (file) {
            await transcript(
              file,
              false,
              data.userId,
              data.filename,
              workspaceId
            );
          } else {
            console.log("Error while getting transcript");
          }
        } catch (error) {
          console.error("transcription-error ", { error });
        }
      }

      // Complete processing
      const stopProcessing = await axios.post(
        `${process.env.NEXT_API_HOST}/recording/${data.userId}/complete`,
        {
          filename: data.filename,
          videoUrl: uploadFile.secure_url,
          videoId: uploadFile.public_id,
        }
      );

      if (stopProcessing.data.status !== 200) {
        console.log(
          "Error: Something went wrong when stopping the process and try to complete the processing stage"
        );
      }

      // if (stopProcessing.data.status === 200) {
      //   // Clean up temporary file
      //   fs.unlink(filePath, (err) => {
      //     if (!err) {
      //       console.log("🗑️ " + data.filename + " deleted successfully");
      //     } else {
      //       console.error("❌ Error deleting file:", err);
      //     }
      //   });
      // }
    } catch (error) {
      console.error("🔴 Error processing video:", error);
      socket.emit("upload-error", { message: "Failed to process video" });
    } finally {
      // [filePath, audioPath].forEach((p) => {
      //   if (p == audioPath && plan === "PRO") {
      //     fs.unlink(p, (err) => {
      //       if (!err) {
      //         console.log(`${p} file removed`);
      //       } else {
      //         console.log("Error while removing, ", p, err);
      //       }
      //     });
      //   } else if (p == filePath) {
      //     fs.unlink(p, (err) => {
      //       if (!err) {
      //         console.log(`${p} file removed`);
      //       } else {
      //         console.log("Error while removing, ", p, err);
      //       }
      //     });
      //   }
      // });
      fs.unlink(filePath, (err) => {
        if (err) console.error("Error deleting temp file:", filePath, err);
        else console.log("🗑️ Temp file deleted:", filePath);
      });
      fs.unlink(audioPath, (err) => {
        if (err) console.error("Error deleting temp file:", audioPath, err);
        else console.log("🗑️ Temp file deleted:", audioPath);
      })
    }
  });
});

server.listen(5000, () => {
  console.log("🚀 Server listening on port 5000");
});
