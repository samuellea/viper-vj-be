require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Request logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`, {
    body: req.body,
    query: req.query,
    params: req.params
  });
  next();
});

// Initialize Firebase Admin
let db;
try {
  const serviceAccountPath = path.resolve(__dirname, process.env.FIREBASE_SERVICE_ACCOUNT_PATH || '../viper-js-firebase-adminsdk.json');
  
  console.log('Loading Firebase service account from:', serviceAccountPath);
  
  if (!fs.existsSync(serviceAccountPath)) {
    throw new Error(`Firebase service account file not found at: ${serviceAccountPath}`);
  }
  
  const serviceAccount = require(serviceAccountPath);
  
  if (!serviceAccount.project_id || !serviceAccount.private_key || !serviceAccount.client_email) {
    throw new Error('Invalid Firebase service account file. Missing required fields.');
  }
  
  const databaseURL = process.env.FIREBASE_DATABASE_URL || 'https://viper-vj-default-rtdb.europe-west1.firebasedatabase.app';
  console.log('Initializing Firebase Admin with database URL:', databaseURL);
  
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: databaseURL
  });
  
  db = admin.database();
  console.log('Firebase Admin initialized successfully');
  
  // Test database access with a simple read operation
  // Note: Admin SDK doesn't maintain persistent connections like client SDK
  // The .info/connected check doesn't work the same way
  try {
    const testRef = db.ref('.info/serverTimeOffset');
    testRef.once('value', () => {
      console.log('✓ Database access verified - can read from Firebase');
    }).catch((err) => {
      console.error('✗ ERROR: Cannot access Firebase database:', err.message);
      console.error('Please verify:');
      console.error('1. Database URL is correct:', databaseURL);
      console.error('2. Realtime Database is enabled in Firebase Console');
      console.error('3. Database exists for project:', serviceAccount.project_id);
      console.error('4. Service account has proper permissions');
      console.error('5. Database rules allow admin access (Admin SDK bypasses rules)');
    });
  } catch (err) {
    console.error('Error setting up database connection test:', err);
  }
  
  // Suppress the Firebase warning about .info/connected - it's normal for Admin SDK
  console.log('Note: Firebase Admin SDK warnings about .info/connected are normal and can be ignored.');
  
} catch (error) {
  console.error('FATAL ERROR: Failed to initialize Firebase Admin:', error);
  console.error('Error details:', {
    message: error.message,
    stack: error.stack,
    serviceAccountPath: process.env.FIREBASE_SERVICE_ACCOUNT_PATH || '../viper-js-firebase-adminsdk.json'
  });
  process.exit(1);
}

// Helper function to fetch YouTube video title
async function getYouTubeVideoTitle(videoId) {
  try {
    const response = await axios.get(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`, {
      timeout: 5000
    });
    return response.data.title || 'Untitled Video';
  } catch (error) {
    console.warn(`Could not fetch title for video ${videoId}:`, error.message);
    return 'Untitled Video';
  }
}

// POST /videos - Save video with hotcues
app.post('/videos', async (req, res) => {
  try {
    console.log('POST /videos - Request received');
    console.log('Request body:', JSON.stringify(req.body, null, 2));
    
    const { youtubeUrl, videoId, hotcues } = req.body;

    // Validation
    if (!youtubeUrl || !videoId) {
      const missingFields = [];
      if (!youtubeUrl) missingFields.push('youtubeUrl');
      if (!videoId) missingFields.push('videoId');
      
      console.error('Validation error: Missing required fields:', missingFields);
      return res.status(400).json({ 
        error: 'Missing required fields',
        missingFields: missingFields,
        received: { youtubeUrl: !!youtubeUrl, videoId: !!videoId, hotcues: !!hotcues }
      });
    }

    // Validate hotcues format
    if (hotcues && typeof hotcues !== 'object') {
      console.error('Validation error: hotcues must be an object');
      return res.status(400).json({ 
        error: 'Invalid hotcues format',
        details: 'hotcues must be an object'
      });
    }

    // Fetch video title from YouTube
    console.log('Fetching video title for:', videoId);
    const title = await getYouTubeVideoTitle(videoId);
    console.log('Video title:', title);

    // Create video data object
    const videoData = {
      youtubeUrl,
      videoId,
      title,
      hotcues: hotcues || {},
      createdAt: admin.database.ServerValue.TIMESTAMP,
      updatedAt: admin.database.ServerValue.TIMESTAMP
    };

    console.log('Saving to Firebase:', {
      path: `videos/${videoId}`,
      data: { ...videoData, createdAt: 'SERVER_VALUE', updatedAt: 'SERVER_VALUE' }
    });

    // Save to Firebase Realtime Database
    // Using videoId as the key for easy lookup
    const videoRef = db.ref(`videos/${videoId}`);
    
    try {
      await videoRef.set(videoData);
      console.log('Successfully saved to Firebase');
      
      res.json({ 
        success: true, 
        message: 'Video saved successfully',
        videoId,
        savedAt: new Date().toISOString()
      });
    } catch (firebaseError) {
      console.error('Firebase error:', firebaseError);
      console.error('Firebase error details:', {
        code: firebaseError.code,
        message: firebaseError.message,
        stack: firebaseError.stack
      });
      
      res.status(500).json({ 
        error: 'Failed to save to Firebase Realtime Database',
        details: firebaseError.message,
        code: firebaseError.code || 'UNKNOWN',
        type: 'FIREBASE_ERROR'
      });
    }
  } catch (error) {
    console.error('Unexpected error saving video:', error);
    console.error('Error stack:', error.stack);
    
    res.status(500).json({ 
      error: 'Internal server error',
      details: error.message,
      type: 'SERVER_ERROR',
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// GET /videos - Get all videos
app.get('/videos', async (req, res) => {
  try {
    console.log('GET /videos - Fetching all videos');
    
    const videosRef = db.ref('videos');
    const snapshot = await videosRef.once('value');
    
    if (!snapshot.exists()) {
      console.log('No videos found');
      return res.json([]);
    }

    const videos = snapshot.val();
    // Convert object to array with videoId included
    const videosArray = Object.keys(videos).map(videoId => ({
      videoId,
      ...videos[videoId]
    }));

    // Sort by updatedAt (most recent first)
    videosArray.sort((a, b) => {
      const aTime = a.updatedAt || a.createdAt || 0;
      const bTime = b.updatedAt || b.createdAt || 0;
      return bTime - aTime;
    });

    console.log(`Found ${videosArray.length} videos`);
    res.json(videosArray);
  } catch (error) {
    console.error('Error fetching videos:', error);
    console.error('Error stack:', error.stack);
    
    res.status(500).json({ 
      error: 'Failed to fetch videos',
      details: error.message,
      type: 'FIREBASE_ERROR',
      code: error.code || 'UNKNOWN'
    });
  }
});

// GET /videos/:videoId - Get video with hotcues
app.get('/videos/:videoId', async (req, res) => {
  try {
    const { videoId } = req.params;
    console.log('GET /videos/:videoId - Request for videoId:', videoId);
    
    const videoRef = db.ref(`videos/${videoId}`);
    const snapshot = await videoRef.once('value');
    
    if (!snapshot.exists()) {
      console.log('Video not found:', videoId);
      return res.status(404).json({ 
        error: 'Video not found',
        videoId 
      });
    }

    console.log('Video found:', videoId);
    res.json(snapshot.val());
  } catch (error) {
    console.error('Error fetching video:', error);
    console.error('Error stack:', error.stack);
    
    res.status(500).json({ 
      error: 'Failed to fetch video',
      details: error.message,
      type: 'FIREBASE_ERROR',
      code: error.code || 'UNKNOWN'
    });
  }
});

// DELETE /videos/:videoId - Delete a video
app.delete('/videos/:videoId', async (req, res) => {
  try {
    const { videoId } = req.params;
    console.log('DELETE /videos/:videoId - Request to delete videoId:', videoId);
    
    const videoRef = db.ref(`videos/${videoId}`);
    const snapshot = await videoRef.once('value');
    
    if (!snapshot.exists()) {
      console.log('Video not found for deletion:', videoId);
      return res.status(404).json({ 
        error: 'Video not found',
        videoId 
      });
    }

    // Delete the video
    await videoRef.remove();
    console.log('Video deleted successfully:', videoId);
    
    res.json({ 
      success: true, 
      message: 'Video deleted successfully',
      videoId 
    });
  } catch (error) {
    console.error('Error deleting video:', error);
    console.error('Error stack:', error.stack);
    
    res.status(500).json({ 
      error: 'Failed to delete video',
      details: error.message,
      type: 'FIREBASE_ERROR',
      code: error.code || 'UNKNOWN'
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Error handling middleware (must be last)
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    details: err.message,
    type: 'UNHANDLED_ERROR'
  });
});

app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
  console.log('Environment:', {
    NODE_ENV: process.env.NODE_ENV || 'development',
    PORT: PORT,
    FIREBASE_DATABASE_URL: process.env.FIREBASE_DATABASE_URL || 'https://viper-vj-default-rtdb.europe-west1.firebasedatabase.app'
  });
});
