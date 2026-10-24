# IntelliSubmit Server

Backend REST API server for the IntelliSubmit academic paper submission and peer review platform.

## Features
- Manuscript file uploads via Multer (.pdf, .doc, .docx)
- MongoDB integration for paper metadata, revision history, and review tokens
- Peer review token generation and status state management
- CORS enabled for IntelliSubmit client

## Getting Started

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment Variables
Copy `.env.example` to `.env` and set your MongoDB connection string:
```env
PORT=5000
MONGODB_URI=mongodb+srv://...
CLIENT_URL=http://localhost:3000
```

### 3. Run the Server
```bash
node index.js
```
