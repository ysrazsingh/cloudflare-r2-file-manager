const express = require("express");
const bodyParser = require("body-parser");
const dotenv = require("dotenv");
const cors = require("cors");
const path = require("path");
const multer = require("multer");
const { S3Client, PutObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, CopyObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

dotenv.config();

const app = express();
app.use(bodyParser.json());
app.use(cors());

const s3 = new S3Client({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

const upload = multer({ storage: multer.memoryStorage() });

const BUCKET_NAME = process.env.R2_BUCKET_NAME;

// Helper to convert S3 streams to strings
const streamToString = async (stream) => {
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf-8");
};

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "templates/index.html"));
});

// 1. Create a file inside a folder
app.post("/create-file", async (req, res) => {
    const { folder, fileName, content } = req.body;

    const params = {
        Bucket: BUCKET_NAME,
        Key: `${folder}/${fileName}`,
        Body: JSON.stringify(content),
        ContentType: "application/json"
    };

    try {
        const command = new PutObjectCommand(params);
        await s3.send(command);
        res.status(201).send({ message: "File created successfully" });
    } catch (error) {
        res.status(500).send({ error: error.message });
    }
});

// 2. Delete a file inside a folder
app.delete("/delete-file", async (req, res) => {
    const { folder, fileName, fileNames } = req.body;

    try {
        // Handle batch deletion
        if (fileNames && Array.isArray(fileNames)) {
            const deleteParams = {
                Bucket: BUCKET_NAME,
                Delete: {
                    Objects: fileNames.map((name) => ({ Key: `${folder}/${name}` }))
                }
            };

            const deleteCommand = new DeleteObjectsCommand(deleteParams);
            const result = await s3.send(deleteCommand);

            const deletedCount = result.Deleted ? result.Deleted.length : 0;
            const errorCount = result.Errors ? result.Errors.length : 0;

            if (errorCount > 0) {
                // Some files failed to delete
                const errorMessages = result.Errors.map(err => `${err.Key}: ${err.Message}`).join('; ');
                return res.status(207).send({
                    message: `Deleted ${deletedCount} files successfully, ${errorCount} files failed`,
                    deleted: deletedCount,
                    failed: errorCount,
                    errors: result.Errors
                });
            }

            res.status(200).send({ message: `Deleted ${deletedCount} files successfully` });
            return;
        }

        if (fileName === "*") {
            // Delete all files in the folder
            const listParams = {
                Bucket: BUCKET_NAME,
                Prefix: `${folder}/`
            };

            const listCommand = new ListObjectsV2Command(listParams);
            const listData = await s3.send(listCommand);

            if (!listData.Contents || listData.Contents.length === 0) {
                return res.status(404).send({ message: "No files found in the folder" });
            }

            const deleteParams = {
                Bucket: BUCKET_NAME,
                Delete: {
                    Objects: listData.Contents.map((item) => ({ Key: item.Key }))
                }
            };

            const deleteCommand = new DeleteObjectsCommand(deleteParams);
            await s3.send(deleteCommand);
            res.status(200).send({ message: `Deleted ${listData.Contents.length} files successfully` });
        } else {
            // Delete single file - first check if it exists
            const headParams = {
                Bucket: BUCKET_NAME,
                Key: `${folder}/${fileName}`
            };

            try {
                await s3.send(new HeadObjectCommand(headParams));
            } catch (error) {
                if (error.name === 'NotFound') {
                    // File doesn't exist - treat as success for idempotency
                    return res.status(200).send({ message: "File already deleted or doesn't exist" });
                }
                throw error;
            }

            const params = {
                Bucket: BUCKET_NAME,
                Key: `${folder}/${fileName}`
            };

            const command = new DeleteObjectCommand(params);
            await s3.send(command);
            res.status(200).send({ message: "File deleted successfully" });
        }
    } catch (error) {
        res.status(500).send({ error: error.message });
    }
});

// 3. Update a file inside a folder (overwrite)
app.put("/update-file", async (req, res) => {
    const { folder, fileName, content } = req.body;

    const params = {
        Bucket: BUCKET_NAME,
        Key: `${folder}/${fileName}`,
        Body: JSON.stringify(content),
        ContentType: "application/json"
    };

    try {
        const command = new PutObjectCommand(params);
        await s3.send(command);
        res.status(200).send({ message: "File updated successfully" });
    } catch (error) {
        res.status(500).send({ error: error.message });
    }
});

// 4. Read a file inside a folder
app.get("/read-file", async (req, res) => {
    const { folder, fileName } = req.query;

    const params = {
        Bucket: BUCKET_NAME,
        Key: `${folder}/${fileName}`
    };

    try {
        const command = new GetObjectCommand(params);
        const data = await s3.send(command);
        const content = await streamToString(data.Body);
        res.status(200).send(JSON.parse(content));
    } catch (error) {
        res.status(500).send({ error: error.message });
    }
});

// 5. List files inside a folder or root
app.get("/list-files", async (req, res) => {
    const { folder } = req.query;

    // Adjust the Prefix based on whether a folder is specified
    const params = {
        Bucket: BUCKET_NAME,
        Prefix: folder ? `${folder}/` : "",
        Delimiter: "/" // To distinguish folders at root level
    };

    try {
        const command = new ListObjectsV2Command(params);
        const data = await s3.send(command);

        // Get files and folders
        const files = data.Contents?.map((item) => item.Key) || [];
        const folders = data.CommonPrefixes?.map((item) => item.Prefix) || [];

        res.status(200).send({ files, folders });
    } catch (error) {
        res.status(500).send({ error: error.message });
    }
});

// List large folders with bounded responses and a continuation cursor.
app.get("/list-files-paginated", async (req, res) => {
    const { folder, limit = "1000", cursor } = req.query;

    if (folder !== undefined && typeof folder !== "string") {
        return res.status(400).send({ error: "folder must be a string" });
    }
    if (typeof limit !== "string" || !/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 10000) {
        return res.status(400).send({ error: "limit must be an integer between 1 and 10000" });
    }
    if (cursor !== undefined && (typeof cursor !== "string" || cursor.length === 0)) {
        return res.status(400).send({ error: "cursor must be a non-empty string" });
    }

    const maxItems = Number(limit);
    const files = [];
    const folders = [];
    let nextCursor = cursor;
    let hasMore = false;

    try {
        do {
            const params = {
                Bucket: BUCKET_NAME,
                Prefix: folder ? `${folder.replace(/\/+$/, "")}/` : "",
                Delimiter: "/",
                MaxKeys: Math.min(1000, maxItems - files.length - folders.length)
            };
            if (nextCursor !== undefined) {
                params.ContinuationToken = nextCursor;
            }

            const data = await s3.send(new ListObjectsV2Command(params));
            hasMore = data.IsTruncated === true;
            if (hasMore && (!data.NextContinuationToken || data.NextContinuationToken === nextCursor)) {
                throw new Error("R2 did not return a usable continuation token");
            }

            files.push(...(data.Contents || []).map((item) => item.Key));
            folders.push(...(data.CommonPrefixes || []).map((item) => item.Prefix));
            nextCursor = hasMore ? data.NextContinuationToken : undefined;
        } while (hasMore && files.length + folders.length < maxItems);

        res.status(200).send({
            files,
            folders,
            count: files.length + folders.length,
            hasMore,
            nextCursor: nextCursor ?? null
        });
    } catch (error) {
        res.status(500).send({ error: error.message });
    }
});

// 6. List all folders
app.get("/list-folders", async (req, res) => {
    const params = {
        Bucket: BUCKET_NAME,
        Delimiter: "/"
    };

    try {
        const command = new ListObjectsV2Command(params);
        const data = await s3.send(command);

        const folders = data.CommonPrefixes?.map((prefix) => prefix.Prefix) || [];
        res.status(200).send(folders);
    } catch (error) {
        res.status(500).send({ error: error.message });
    }
});

// 7. Duplicate a folder
app.post("/duplicate-folder", async (req, res) => {
    const { sourceFolder, targetFolder } = req.body;

    const listParams = {
        Bucket: BUCKET_NAME,
        Prefix: `${sourceFolder}/`
    };

    try {
        // List all objects in the source folder
        const listCommand = new ListObjectsV2Command(listParams);
        const listData = await s3.send(listCommand);

        if (!listData.Contents || listData.Contents.length === 0) {
            return res.status(404).send({ message: "Source folder is empty or not found" });
        }

        // Copy each object to the target folder
        const copyPromises = listData.Contents.map(async (item) => {
            const copyParams = {
                Bucket: BUCKET_NAME,
                CopySource: `${BUCKET_NAME}/${item.Key}`,
                Key: item.Key.replace(sourceFolder, targetFolder)
            };
            const copyCommand = new CopyObjectCommand(copyParams);
            return s3.send(copyCommand);
        });

        await Promise.all(copyPromises);
        res.status(201).send({ message: "Folder duplicated successfully" });
    } catch (error) {
        res.status(500).send({ error: error.message });
    }
});

// 8. Rename a folder
app.put("/rename-folder", async (req, res) => {
    const { sourceFolder, targetFolder } = req.body;

    const listParams = {
        Bucket: BUCKET_NAME,
        Prefix: `${sourceFolder}/`
    };

    try {
        // List all objects in the source folder
        const listCommand = new ListObjectsV2Command(listParams);
        const listData = await s3.send(listCommand);

        if (!listData.Contents || listData.Contents.length === 0) {
            return res.status(404).send({ message: "Source folder is empty or not found" });
        }

        // Copy each object to the target folder and delete original
        const copyAndDeletePromises = listData.Contents.map(async (item) => {
            const newKey = item.Key.replace(sourceFolder, targetFolder);

            // Copy object to new location
            const copyParams = {
                Bucket: BUCKET_NAME,
                CopySource: `${BUCKET_NAME}/${item.Key}`,
                Key: newKey
            };
            const copyCommand = new PutObjectCommand(copyParams);
            await s3.send(copyCommand);

            // Delete original object
            const deleteParams = {
                Bucket: BUCKET_NAME,
                Key: item.Key
            };
            const deleteCommand = new DeleteObjectCommand(deleteParams);
            return s3.send(deleteCommand);
        });

        await Promise.all(copyAndDeletePromises);
        res.status(200).send({ message: "Folder renamed successfully" });
    } catch (error) {
        res.status(500).send({ error: error.message });
    }
});

// 9. Upload media file
app.post(
    "/upload-files",
    (req, res, next) => {
        upload.array("files", 50)(req, res, (err) => {
            if (err instanceof multer.MulterError) {
                if (err.code === "LIMIT_FILE_COUNT") {
                    return res.status(400).send({ error: "Too many files. Maximum 50 files allowed." });
                }
                return res.status(400).send({ error: err.message });
            } else if (err) {
                return res.status(500).send({ error: err.message });
            }
            next();
        });
    },
    async (req, res) => {
        const folder = req.body.folder || "uploads";
        const files = req.files;

        if (!files || files.length === 0) {
            return res.status(400).send({ message: "No files uploaded" });
        }

        try {
            const uploadPromises = files.map((file) => {
                const params = {
                    Bucket: BUCKET_NAME,
                    Key: `${folder}/${file.originalname}`,
                    Body: file.buffer,
                    ContentType: file.mimetype
                };

                const command = new PutObjectCommand(params);
                return s3.send(command);
            });

            await Promise.all(uploadPromises);
            res.status(201).send({
                message: "Files uploaded successfully",
                fileNames: files.map((file) => file.originalname)
            });
        } catch (error) {
            res.status(500).send({ error: error.message });
        }
    }
);

// 10. Get URLs for files inside a folder or root
app.get("/get-file-urls", async (req, res) => {
    const { folder, expires } = req.query; // Accept `expires` as a query parameter

    const params = {
        Bucket: BUCKET_NAME,
        Prefix: folder ? `${folder}/` : ""
    };

    try {
        const command = new ListObjectsV2Command(params);
        const data = await s3.send(command);

        const files = data.Contents?.map((item) => item.Key) || [];

        // Generate pre-signed URLs for the files
        const urls = await Promise.all(
            files.map(async (fileKey) => {
                // Generate URL without expiration if expires is not provided
                const urlOptions = expires
                    ? { expiresIn: parseInt(expires, 10) } // Use the provided expiration time
                    : undefined; // No expiration

                const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET_NAME, Key: fileKey }), urlOptions);

                return { fileKey, url };
            })
        );

        res.status(200).send(urls);
    } catch (error) {
        res.status(500).send({ error: error.message });
    }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

module.exports = app;
