# Cloudflare R2 File Manager

`cloudflare-r2-file-manager` is a full-stack web application for managing files and folders stored in Cloudflare R2. It provides both a modern web interface and REST API for performing CRUD operations on files and folders within your R2 bucket.

## ✨ Features

### 🖥️ Web Interface

- **Modern UI**: Clean, responsive web interface built with HTML5, Tailwind CSS, and Alpine.js
- **File Browser**: Navigate folders with breadcrumb navigation
- **Multi-Select**: Advanced file selection with Shift+Click range selection, Ctrl+A, and Esc to clear
- **Drag & Drop**: Intuitive file and folder upload interface
- **Real-time Feedback**: Toast notifications and progress indicators

### 📁 File Management

- **Create** JSON files and folders
- **Read** and **update** file contents
- **Delete** single files or multiple files in batch
- **Upload** multiple files (up to 50 per request) with progress tracking
- **Folder Upload**: Upload entire directory structures while preserving hierarchy
- **Batch Operations**: Delete multiple files in a single request

### 🔧 Advanced Features

- **Natural Sorting**: Proper alphanumeric sorting for files and folders
- **Keyboard Shortcuts**: Full keyboard navigation support
- **Responsive Design**: Mobile-friendly interface
- **Progress Tracking**: Real-time upload progress with visual indicators
- **Error Handling**: Comprehensive error handling with user-friendly messages

### 🌐 API Endpoints

- RESTful API for all file operations
- Pre-signed URL generation for secure file access
- Batch operations for improved performance
- CORS support for web applications

## Prerequisites

- Node.js (v14 or above)
- Cloudflare R2 account and API credentials

## Setup

1. **Clone the repository:**

    ```bash
    https://github.com/YsrajSingh/cloudflare-r2-file-manager.git
    cd cloudflare-r2-file-manager
    ```

2. **Install dependencies:**

    ```bash
    npm install
    ```

3. **Create an .env file** in the root directory with the following content:

    ```bash
    PORT=3000
    AWS_ACCESS_KEY_ID=<your-cloudflare-r2-access-key>
    AWS_SECRET_ACCESS_KEY=<your-cloudflare-r2-secret-key>
    R2_BUCKET_NAME=<your-cloudflare-r2-bucket-name>
    R2_BUCKET=<your-cloudflare-r2-bucket-name>
    R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
    ```

    Replace `<your-cloudflare-r2-access-key>`, `<your-cloudflare-r2-secret-key>`, `<your-cloudflare-r2-bucket-name>`, and `<account-id>` with your Cloudflare R2 credentials.

## Running the Server

To start the server, run:

```bash
npm start
```

The server will be available at `http://localhost:3000`

## Web Interface

Once the server is running, visit `http://localhost:3000` in your browser to access the web interface:

### Features:
- **File Browser**: Navigate through your folders with breadcrumb navigation
- **Multi-Select**: Select multiple files with Shift+Click range selection, Ctrl+A, or individual clicks
- **File Operations**: Create, upload, delete, and manage files and folders
- **Folder Upload**: Upload entire directory structures while preserving hierarchy
- **Batch Operations**: Delete multiple files efficiently in single requests
- **Progress Tracking**: Real-time upload progress with visual indicators
- **Responsive Design**: Works on desktop and mobile devices
- **Keyboard Shortcuts**: Full keyboard navigation support

### Usage:
1. **Navigation**: Click on folders to navigate, use breadcrumbs to go back
2. **File Selection**: Click files to select, Shift+Click for ranges, Ctrl+A for all
3. **Upload**: Use "Upload" button to select files or drag & drop folders
4. **Delete**: Select files and click "Delete" for batch deletion
5. **Create**: Use "New Folder" or "New File" buttons to create content

## API Endpoints

1. **Create a File**

- Endpoint: `POST /create-file`
- Request Body:

    ```json
    {
        "folder": "folder-name",
        "fileName": "file.json",
        "content": { "key": "value" }
    }
    ```

2. **Delete a File**

- Endpoint: `DELETE /delete-file`
- Request Body (single file):

    ```json
    {
        "folder": "folder-name",
        "fileName": "file.json"
    }
    ```

- Request Body (batch delete multiple files):

    ```json
    {
        "folder": "folder-name",
        "fileNames": ["file1.json", "file2.json", "file3.json"]
    }
    ```

- Request Body (delete all files in folder):

    ```json
    {
        "folder": "folder-name",
        "fileName": "*"
    }
    ```

- Response: `{"message": "Deleted X files successfully"}` or `{"message": "Deleted X files successfully, Y files failed", "deleted": X, "failed": Y, "errors": [...]}`

3. **Update a File**

- Endpoint: `PUT /update-file`
- Request Body:

    ```json
    {
        "folder": "folder-name",
        "fileName": "file.json",
        "content": { "key": "updated-value" }
    }
    ```

4. **Read a File**

- Endpoint: `GET /read-file`
- Query Parameters: `folder=folder-name&fileName=file.json`

5. **List Files in a Folder**

- Endpoint: `GET /list-files`
- Query Parameters: `folder=folder-name`

### List more than 1,000 files

- Endpoint: `GET /list-files-paginated`
- Query parameters:
  - `folder`: optional folder path; omit it to list the bucket root.
  - `limit`: maximum number of entries in the response, from `1` to `10000` (default `1000`). The server follows R2 continuation tokens internally when more than one R2 request is needed.
  - `cursor`: optional opaque `nextCursor` from the previous response. Keep the same `folder` when continuing, and URL-encode the cursor with `URLSearchParams`.
- Like `/list-files`, this lists direct children only. Files and child folders both count toward `limit`. Object keys are returned as stored, including folder markers and placeholders if present.

First request, returning up to 5,000 entries:

```http
GET /list-files-paginated?folder=uploads&limit=5000
```

Response shape (abbreviated):

```json
{
    "files": ["uploads/file-1.json", "uploads/file-2.json"],
    "folders": ["uploads/images/"],
    "count": 3,
    "hasMore": true,
    "nextCursor": "opaque-token-from-r2"
}
```

`count` is the number of entries in this response, not the total in the folder. Continue until `hasMore` is `false`; the final response has `nextCursor: null`. An empty folder returns empty arrays and `count: 0`. Invalid query parameter types or limits return HTTP `400`; R2 errors return HTTP `500` without returning a partial list as a success. A listing is not a snapshot: concurrent uploads or deletes can change the results between requests.

Example client that retrieves all pages:

```javascript
const files = [];
const folders = [];
let cursor;

do {
    const query = new URLSearchParams({ folder: "uploads", limit: "5000" });
    if (cursor) query.set("cursor", cursor);

    const response = await fetch(`/list-files-paginated?${query}`);
    const page = await response.json();
    if (!response.ok) throw new Error(page.error || "Failed to list files");

    files.push(...page.files);
    folders.push(...page.folders);
    cursor = page.hasMore ? page.nextCursor : null;
} while (cursor);
```

This is an additional API. The existing endpoints and web interface continue to use their current listing behavior.

6. **List All Folders**

- Endpoint: `GET /list-folders`

7. **Duplicate a Folder**

- Endpoint: `POST /duplicate-folder`
- Request Body:

    ```json
    {
        "sourceFolder": "source-folder",
        "targetFolder": "target-folder"
    }
    ```

8. **Rename a Folder**

- Endpoint: `PUT /rename-folder`
- Request Body:

    ```json
    {
        "sourceFolder": "old-folder-name",
        "targetFolder": "new-folder-name"
    }
    ```

9. **Upload Files**

- Endpoint: `POST /upload-files`
- Content-Type: `multipart/form-data`
- Form Data:
  - `files`: Multiple files (up to 50 per request, processed in batches of 10)
  - `folder`: Target folder name (optional, defaults to "uploads")
- Response: `{"message": "Files uploaded successfully", "fileNames": ["file1.jpg", "file2.png"]}`

10. **Get File URLs**

- Endpoint: `GET /get-file-urls`
- Query Parameters: `folder=folder-name&expires=3600` (expires is optional)
- Returns pre-signed URLs for all files in the specified folder

## Tests

Run `npm test` with Node.js 18 or newer. The HTTP tests mock R2 and do not access a real bucket. They cover multi-page retrieval, cursor encoding, response limits, empty folders, invalid parameters, and failures partway through a listing.

## Contributing

1. Fork the repository.
1. Create a new branch (`git checkout -b feature-name`).
1. Commit your changes (`git commit -am 'Add new feature'`).
1. Push to the branch (`git push origin feature-name`).
1. Create a new pull request.

## License

This project is licensed under the [MIT License](https://github.com/YsrajSingh/cloudflare-r2-file-manager/blob/main/LICENSE).
