const express = require('express');
const path = require('path');
const http = require('http');
const session = require('express-session');
const socketIo = require('socket.io');
const chokidar = require('chokidar');
const fs = require('fs');
const mysql = require('mysql2/promise');
const cron = require('node-cron');

// Database connection
const pool = require('./database.js');

// Middleware
const { sessionMiddleware } = require('./middleware.js');

// Routes
const facilitatorRoutes = require('./routes/facilitator');
const instructorRoutes = require('./routes/instructor');
const guardRoutes = require('./routes/guard');
const adminRoutes = require('./routes/admin');

// Initialize Express app
const app = express();
const port = 3000;

// Create HTTP server
const httpServer = http.createServer(app);
const io = socketIo(httpServer);

// Setup Socket.io
io.on('connection', (socket) => {
  console.log('[Socket.io] A user connected');
  socket.on('disconnect', () => {
    console.log('[Socket.io] User disconnected');
  });
});

// Middleware setup
app.use(express.static(path.join(__dirname, '../frontend')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: 'your_secret_key',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false } // Set to true if using HTTPS
}));

// Static routes
app.get('/403', (req, res) => res.sendFile(path.join(__dirname, '../frontend/403.html')));
app.get('/home', (req, res) => res.sendFile(path.join(__dirname, '../frontend/home.html')));
app.get('/demolive', (req, res) => res.sendFile(path.join(__dirname, '../frontend/demolive.html')));
app.get('/settings', (req, res) => res.sendFile(path.join(__dirname, '../frontend/settings.html')));

// Protected static routes
const $requireRole = (roles) => (req, res, next) => {
  if (req.session.user && roles.includes(req.session.user.role)) {
    next();
  } else {
    res.redirect('/403');
  }
};

app.get('/instructor', $requireRole(['teacher']), (req, res) => res.sendFile(path.join(__dirname, '../frontend/instructor.html')));
app.get('/facilitator', $requireRole(['facilitator']), (req, res) => res.sendFile(path.join(__dirname, '../frontend/facilitator.html')));
app.get('/guard', $requireRole(['guard']), (req, res) => res.sendFile(path.join(__dirname, '../frontend/guard.html')));
app.get('/admin', $requireRole(['admin']), (req, res) => res.sendFile(path.join(__dirname, '../frontend/admin.html')));
app.get('/aibo', $requireRole(['teacher']), (req, res) => res.sendFile(path.join(__dirname, '../frontend/aibo.html')));

// Authentication routes
app.post('/signin', async (req, res) => {
  try {
    const { username, password } = req.body;
    const [rows] = await pool.execute('SELECT * FROM users WHERE username = ?', [username]);
  
    if (rows[0] && rows[0].password === password) {
      req.session.user = rows[0];
      await new Promise((resolve, reject) => {
        req.session.save((err) => {
          if (err) reject(err);
          resolve();
        });
      });

      const redirectPaths = {
        teacher: '/instructor',
        admin: '/admin',
        facilitator: '/facilitator',
        guard: '/guard'
      };

      console.log('[Attendify] logged in as', req.session.user.username);
      res.redirect(redirectPaths[req.session.user.role]);
      setupChokidar(req);
      console.log(JSON.stringify(req.session.user))

    } else {
      res.status(401).send(`Invalid credentials <a href='/home'>Go back.</a>`);
    }
  } catch (error) {
    console.error('[Attendify] Login error:', error);
    res.status(500).send('Internal server error');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

// Root route with role-based redirect
app.get('/', (req, res) => {
  if (req.session.user) {
    const redirectPaths = {
      teacher: '/instructor',
      admin: '/admin',
      facilitator: '/facilitator',
      guard: '/guard'
    };
    console.log(req.session.user.role);
    res.redirect(redirectPaths[req.session.user.role]);
  } else {
    console.log("[Debug] No user session, redirecting to /home");
    res.redirect('/home');
  }
});

// API routes
app.use('/facilitator', $requireRole(['facilitator']), facilitatorRoutes);
app.use('/instructor', $requireRole(['teacher']), instructorRoutes);
app.use('/guard', $requireRole(['guard']), guardRoutes);
app.use('/admin', $requireRole(['admin']), adminRoutes);

// new function

// Watch data.json for changes
const dataPath = path.join(__dirname, '../data/data.json');

// Function to read data from data.json
// extensive checking
function readData() {
  try {
    if (!fs.existsSync(dataPath)) {
      console.error("[Attendify] data.json does not exist!");
      return {};
    }

    const rawData = fs.readFileSync(dataPath, 'utf8').trim(); // Trim extra spaces
    console.log("[DEBUG] Raw data from data.json:", rawData);

    if (!rawData) {
      console.error("[Attendify] data.json is empty!");
      return {};
    }

    const jsonData = JSON.parse(rawData);

    if (typeof jsonData !== 'object' || Array.isArray(jsonData) || Object.keys(jsonData).length === 0) {
      console.error("[Attendify] Invalid JSON format!");
      return {};
    }

    return jsonData;
  } catch (error) {
    console.error("[Attendify] Error reading data.json:", error);
    return {};
  }
}



// Function to write data to data.json
function writeData(data) {
  try {
      fs.writeFileSync(dataPath, JSON.stringify(data, null, 2), 'utf8');
      return true;
  } catch (error) {
      console.error("Error writing to data.json:", error);
      return false;
  }
}

app.post('/api/updateData', (req, res) => {
  if (!req.session.user || !req.session.user.username) {
      return res.status(401).json({ message: 'Unauthorized' });
  }

  const username = req.session.user.username;
  const update = req.body; // Data to update

  const currentData = readData();
  const newData = { ...currentData, ...update };

  if (writeData(newData)) {
      console.log(`[Attendify] data.json updated by ${username}:`, newData);
      io.emit('dataUpdated', { data: newData, user: username });
      res.status(200).json({ message: 'Data updated successfully' });
  } else {
      res.status(500).json({ message: 'Failed to update data' });
  }
});


function isValidAttendanceEntry(entry) {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    typeof entry.timeIn === 'string' &&
    typeof entry.status === 'string' &&
    (entry.status.toLowerCase() !== 'out' || typeof entry.timeOut === 'string') // timeOut required if status is 'Out'
  );
}


async function processAttendanceData(updatedData, ME) {
  const moment = require('moment-timezone');
  const timezone = 'Asia/Manila';
  const now = moment().tz(timezone);
  const today = now.format('YYYY-MM-DD');
  const timeString = now.format('HH:mm:ss');
  const dayName = now.format('ddd');

  // console.log("[Attendify] Raw updatedData received:", JSON.stringify(updatedData, null, 2));
  // console.log("[Attendify] Updated data.json content:", JSON.stringify(updatedData, null, 2));
  console.log("[Attendify] Instructor username:", ME);

  // Find ongoing class and get start_time
  const [ongoing_class] = await pool.execute(
    `SELECT class_id, start_time FROM classes 
     WHERE teacher_username = ? 
       AND day = ? 
       AND STR_TO_DATE(?, '%H:%i:%s') BETWEEN start_time AND end_time 
     LIMIT 1`,
    [ME, dayName, timeString]
  );

  if (ongoing_class.length === 0) {
    console.error(`[Attendify] No ongoing class found for instructor ${ME}`);
    return;
  }
  
  const classId = ongoing_class[0].class_id;
  const classStartTime = moment(ongoing_class[0].start_time, "HH:mm:ss");
  console.log(`[Attendify] Found ongoing class ${classId} (Start: ${classStartTime.format("HH:mm:ss")})`);

  if (!updatedData || Object.keys(updatedData).length === 0) {
    console.error("[Attendify] No attendance data found in the updated file.");
    return;
  }

  for (const rfid in updatedData) {
    const studentData = updatedData[rfid];

    // 🔍 Validate the format before processing
    if (!isValidAttendanceEntry(studentData)) {
      console.error(`[Attendify] Invalid data format for key: ${rfid}`, studentData);
      continue; // ⏭️ Skip invalid entries
    }

    // Retrieve student ID
    const [studentRows] = await pool.execute(
      `SELECT student_id FROM students WHERE rfid = ? LIMIT 1`,
      [rfid]
    );

    if (studentRows.length === 0) {
      console.warn(`[Attendify] No student found with RFID ${rfid}`);
      continue;
    }

    const studentId = studentRows[0].student_id;

    if (studentData.status.toLowerCase() === 'in') {
      // const studentTimeIn = moment(studentData.timeIn, "HH:mm:ss");
      const studentTimeIn = moment(studentData.timeIn, "YYYY-MM-DD HH:mm:ss").tz(timezone);
      const lateThreshold = classStartTime.clone().add(15, "minutes");
      console.log(studentTimeIn, lateThreshold)
      console.log(`[Attendify] Class start time: ${classStartTime.format("HH:mm:ss")}`);
      console.log(`[Attendify] Late threshold: ${lateThreshold.format("HH:mm:ss")}`);
      console.log(`[Attendify] Student time in: ${studentTimeIn.format("HH:mm:ss")}`);
      console.log(`[Attendify] Is student after threshold? ${studentTimeIn.isAfter(lateThreshold)}`);

      // Determine attendance status
      const attendanceStatus = studentTimeIn.isAfter(lateThreshold) ? "late" : "present";

      console.log(`[Attendify] Student ${studentId} checked in at ${studentTimeIn.format("HH:mm:ss")} → Marked as ${attendanceStatus.toUpperCase()}`);

      const checkInQuery = `
        UPDATE attendance 
        SET time_in = ?, status = ?, updated_at = NOW()
        WHERE student_id = ? AND class_id = ? AND attendance_date = ?
      `;
      await pool.execute(checkInQuery, [studentData.timeIn, attendanceStatus, studentId, classId, today]);

    } else if (studentData.status.toLowerCase() === 'out') {
      const timeOut = studentData.timeOut;
      if (!timeOut) {
        console.warn(`[Attendify] Missing timeOut for student with RFID ${rfid} marked as Out`);
        continue;
      }

      console.log(`[Attendify] Checking out: RFID ${rfid}, student ${studentId}, timeOut: ${timeOut}`);

      const checkOutQuery = `
        UPDATE attendance 
        SET time_out = ?, updated_at = NOW()
        WHERE student_id = ? AND class_id = ? AND attendance_date = ? AND time_out IS NULL
      `;
      await pool.execute(checkOutQuery, [timeOut, studentId, classId, today]);
    } else {
      console.warn(`[Attendify] Unknown status "${studentData.status}" for RFID ${rfid}`);
    }
  }
}

function isValidTimestamp(timestamp) {
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(timestamp.trim()); // Trim spaces
}


function isValidDataStructure(data) {
  if (typeof data !== 'object' || Array.isArray(data)) return false;

  for (const [key, value] of Object.entries(data)) {
    if (typeof key !== 'string' || !/^[A-F0-9]{2} [A-F0-9]{2} [A-F0-9]{2} [A-F0-9]{2}$/.test(key)) {
      console.error(`[Attendify] Invalid key format: ${key}`);
      return false;
    }

    if (
      typeof value !== 'object' ||
      !value.timeIn ||
      !isValidTimestamp(value.timeIn) ||
      !["In", "Out"].includes(value.status) ||  // ✅ Allow both "In" and "Out"
      (value.timeOut && !isValidTimestamp(value.timeOut))
    ) {
      console.error(`[Attendify] Invalid data format for key: ${key}`, value);
      return false;
    }
    
  }
  return true;
}

function setupChokidar(req) {
  const ME = req.session?.user?.username || 'external';
  console.log("working? setupChokidar");

  if (!fs.existsSync(dataPath)) {
    console.error(`[Attendify] Error: data.json not found at ${dataPath}`);
    return;
  }

  chokidar.watch(dataPath).on('change', async () => {
    console.log("[Attendify] Detected change in data.json, processing...");

    const updatedData = readData();

    if (!updatedData || Object.keys(updatedData).length === 0) {
      console.warn(`[Attendify] Skipping processing: data.json is empty.`);
      io.emit('fileChanged', { data: {}, user: ME }); // 🔥 Ensure UI updates even if data is empty
      return;
    }

    if (!isValidDataStructure(updatedData)) {
      console.error(`[Attendify] Invalid format detected in updated data.json`);
      io.emit('fileChanged', { data: {}, user: ME }); // 🔥 Ensure UI gets an empty update
      return;
    }

    console.log(`[Attendify] data.json changed! ${JSON.stringify(updatedData)}`);
    console.log("data:", updatedData);
    console.log("user:", ME);

    try {
      await processAttendanceData(updatedData, ME);
    } catch (err) {
      console.error('[Attendify] Error processing attendance data:', err);
    }

    io.emit('fileChanged', { data: updatedData, user: ME }); // 🔥 Ensure UI updates!
  });
}

async function prefillAttendance() {
  try {
      console.log(`[Attendify] Starting attendance prefill process at ${new Date().toISOString()}`);

      // 1. Archive current attendance records into attendance_history
      const archiveQuery = `
          INSERT INTO attendance_history (
              attendance_id, student_id, class_id, attendance_date, status,
              time_in, time_out, recorded_by, remark, archived_at
          )
          SELECT 
              attendance_id, student_id, class_id, attendance_date, status,
              time_in, time_out, recorded_by, remark, NOW()
          FROM attendance
      `;
      await pool.execute(archiveQuery);
      console.log(`[Attendify] Archived attendance records to history.`);

      // 2. Truncate the attendance table
      await pool.execute(`TRUNCATE TABLE attendance`);
      console.log(`[Attendify] Attendance table truncated.`);

      // 3. Prefill attendance for today's classes
      const prefillQuery = `
          INSERT INTO attendance (student_id, class_id, attendance_date, status, recorded_by)
          SELECT sc.student_id, cm.class_id, CURDATE(), 'absent', 'system'
          FROM student_classes sc
          JOIN classes cm ON sc.class_id = cm.class_id
          WHERE cm.day = DATE_FORMAT(CURDATE(), '%a')
            AND sc.enrollment_type IN ('preset', 'manual')
            AND NOT EXISTS (
                SELECT 1 FROM attendance a
                WHERE a.student_id = sc.student_id 
                  AND a.class_id = cm.class_id 
                  AND a.attendance_date = CURDATE()
            )
      `;
      await pool.execute(prefillQuery);
      console.log(`[Attendify] Attendance prefilled for ${new Date().toISOString()}.`);

  } catch (error) {
      console.error(`[Attendify] Error during attendance prefill process:`, error);
  }
}



prefillAttendance()

// Start server
httpServer.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});

cron.schedule('0 0 * * *', prefillAttendance); // Run daily at midnight

// Endpoint to record student attendance (Time In / Time Out)
app.post('/api/attendance', async (req, res) => {
  const { studentId, status, timestamp } = req.body;
  
  if (!studentId || !status || !timestamp) {
    return res.status(400).json({ message: 'Missing required fields: studentId, status, and timestamp' });
  }

  try {
    // Use the ME variable (current instructor username from the session) as in your socket setup
    const ME = req.session?.user?.username || 'external';

    // Get current time details using moment-timezone (same as your instructor/ongoing endpoint)
    const moment = require('moment-timezone');
    const timezone = 'Asia/Manila';
    const now = moment().tz(timezone);
    const timeString = now.format('HH:mm:ss');
    const dayName = now.format('ddd'); // Short day name e.g. "Mon", "Tue"
    const today = now.format('YYYY-MM-DD');

    // Get the ongoing class for the instructor (using ME)
    const [ongoing_class] = await pool.execute(
      `SELECT 
          cm.class_id
       FROM classes cm
       WHERE cm.teacher_username = ? 
         AND cm.day = ? 
         AND ? BETWEEN cm.start_time AND cm.end_time
       LIMIT 1`,
      [ME, dayName, timeString]
    );

    if (ongoing_class.length === 0) {
      return res.status(404).json({ message: `No ongoing class found for instructor ${ME}` });
    }

    const classId = ongoing_class[0].class_id;

    if (status.toLowerCase() === 'in') {
      // Record "Time In": Update the existing attendance record with the time_in value
      const checkInQuery = `
        UPDATE attendance 
        SET time_in = ?, status = 'present', updated_at = NOW()
        WHERE student_id = ? AND class_id = ? AND attendance_date = ?
      `;
      const [result] = await pool.execute(checkInQuery, [timestamp, studentId, classId, today]);
      
      if (result.affectedRows === 0) {
        return res.status(404).json({ message: 'Attendance record not found for check-in' });
      }
      
      console.log(`[Attendify] Time in recorded for student ${studentId} in class ${classId} at ${timestamp}`);
      return res.status(200).json({ message: 'Time in recorded successfully' });
      
    } else if (status.toLowerCase() === 'out') {
      // Record "Time Out": Update the attendance record with the time_out value if not already set
      const checkOutQuery = `
        UPDATE attendance 
        SET time_out = ?, updated_at = NOW()
        WHERE student_id = ? AND class_id = ? AND attendance_date = ? AND time_out IS NULL
      `;
      const [result] = await pool.execute(checkOutQuery, [timestamp, studentId, classId, today]);
      
      if (result.affectedRows === 0) {
        return res.status(404).json({ message: 'No valid check-in record found for check-out' });
      }
      
      console.log(`[Attendify] Time out recorded for student ${studentId} in class ${classId} at ${timestamp}`);
      return res.status(200).json({ message: 'Time out recorded successfully' });
      
    } else {
      return res.status(400).json({ message: 'Invalid status value. Expected "In" or "Out".' });
    }
  } catch (error) {
    console.error('[Attendify] Error recording attendance:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// Dependencies
const $pool = require('./database.js'); // Import your database connection
const { GoogleGenerativeAI } = require('@google/generative-ai');
const moment = require('moment-timezone');

// API Key
const apiKey = process.env.GOOGLE_API_KEY || "AIzaSyADzZJDCNyZYcJFfiKmPRb9rNyd5O7GVSY"; // Secure your API key
const ai = new GoogleGenerativeAI(apiKey);

// Chat History (MAP) - Store full conversation history per user
const conversations = new Map();

// Maximum conversation history length (adjust as needed)
const MAX_HISTORY_LENGTH = 20; // Store last 20 exchanges

// --- Helper Functions ---

// Function to fetch instructor data (schedule + ongoing class)
async function getInstructorData(username, timezone) {
    try {
        const now = moment().tz(timezone);
        const dayNameShort = now.format('ddd'); // e.g., 'Mon', 'Tue'
        const dateString = now.format('YYYY-MM-DD');
        const currentTime = now.format('HH:mm:ss');

        // Fetch Schedule
        const [me_schedule] = await $pool.execute(`
            SELECT c.course_name, class_meeting.grade_section, class_meeting.day, class_meeting.start_time, class_meeting.end_time
            FROM classes AS class_meeting
            JOIN courses AS c ON class_meeting.course_code = c.course_code
            WHERE class_meeting.teacher_username = ? AND class_meeting.day = DATE_FORMAT(CURDATE(), '%a')
            ORDER BY FIELD(class_meeting.day, 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'), class_meeting.start_time;
        `, [username]);

        let scheduleString = "No schedule available.";
        if (me_schedule && me_schedule.length > 0) {
            scheduleString = me_schedule.map(s => `${s.course_name} (${s.start_time} - ${s.end_time})`).join(", ");
        }

        // Fetch Ongoing Class
        const [ongoing_class] = await $pool.execute(`
            SELECT cm.class_id, c.course_name AS subject, cm.grade_section, cm.start_time, cm.end_time
            FROM classes cm 
            JOIN courses c ON cm.course_code = c.course_code
            WHERE cm.teacher_username = ? AND cm.day = ? AND ? BETWEEN cm.start_time AND cm.end_time
        `, [username, dayNameShort, currentTime]);

        let ongoingClassString = "No ongoing class.";
        if (ongoing_class && ongoing_class.length > 0) {
            ongoingClassString = `Teaching ${ongoing_class[0].subject} (${ongoing_class[0].start_time} - ${ongoing_class[0].end_time})`;
        }

        // Fetch All Students across all classes of the teacher
        const [all_students] = await $pool.execute(`
            SELECT 
                s.student_id,
                s.full_name,
                s.grade_section,
                sc.class_id,
                c.course_name,
                cl.day,
                cl.start_time,
                cl.end_time,
                a.status,
                a.time_in,
                a.time_out,
                a.remark
            FROM students s
            JOIN student_classes sc ON s.student_id = sc.student_id
            JOIN classes cl ON sc.class_id = cl.class_id
            JOIN courses c ON cl.course_code = c.course_code
            LEFT JOIN attendance a 
                ON a.student_id = s.student_id 
                AND a.class_id = cl.class_id 
                AND a.attendance_date = ?
            WHERE cl.teacher_username = ?
            ORDER BY cl.class_id, s.full_name ASC;
        `, [dateString, username]);

        // Format student data
        const students = all_students.map(student => ({
            student_id: student.student_id,
            full_name: student.full_name,
            grade_section: student.grade_section,
            class_id: student.class_id,
            course_name: student.course_name,
            class_day: student.day,
            start_time: student.start_time,
            end_time: student.end_time,
            status: student.status || 'absent',
            time_in: student.time_in ? student.time_in.toString() : null,
            time_out: student.time_out ? student.time_out.toString() : null,
            remark: student.remark || null
        }));


        const [classes] = await $pool.execute(`
            SELECT classes.*, courses.course_name 
            FROM classes
            JOIN courses ON classes.course_code = courses.course_code
            ORDER BY teacher_username
  `);  
        const openschedule = classes.map((classItem) => {
            return {
                class_id: classItem.class_id,
                course_name: classItem.course_name,
                day: classItem.day,
                start_time: classItem.start_time,
                end_time: classItem.end_time
            };
        });

        return {
            schedule: scheduleString,
            ongoing_class: ongoingClassString,
            students, openschedule
        };

    } catch (error) {
        console.error("Error getting instructor data:", error);
        return {
            schedule: "Error fetching schedule",
            ongoing_class: "Error fetching class",
            students: [],
            openschedule: [] 
        };
    }
}


/*
getInstructorData potential response:

{
    schedule: "Math 101 (08:00 - 09:30), Science 101 (10:00 - 11:30)",
    ongoing_class: "Teaching Math 101 (08:00 - 09:30)",
    students: [
        {
            student_id: 1,
            full_name: "John Doe",
            grade_section: "10A",
            class_id: 101,
            course_name: "Math 101",
            class_day: "Mon",
            start_time: "08:00",
            end_time: "09:30",
            status: "present",
            time_in: "08:05",
            time_out: null,
            remark: null
        },
        // ... more students
    ]
}

*/



// Get user's conversation history or initialize if not exists
function getUserHistory(username) {
    if (!conversations.has(username)) {
        conversations.set(username, []); // Initialize with empty array
    }
    return conversations.get(username);
}

// Add a message to the conversation history
function addToHistory(username, role, content) {
    const history = getUserHistory(username);
    history.push({ role, content });
    
    // Maintain maximum history length
    if (history.length > MAX_HISTORY_LENGTH * 2) { // *2 because each exchange has user + assistant message
        history.splice(0, 2); // Remove oldest exchange (user + assistant)
    }
}

// Format history for Gemini API
function formatHistoryForGemini(history) {
    return history.map(msg => `${msg.role}: ${msg.content}`).join('\n');
}

// --- Core Functions ---

// interact with Gemini (Aibo)
async function askAibo(prompt, username, instructorData) {
    const model = ai.getGenerativeModel({ model: "gemini-2.0-flash" });
    
    // Get user history
    const history = getUserHistory(username);
    const formattedHistory = formatHistoryForGemini(history);

    // map all information of student
    let studentDetails =
    `
    ${instructorData.students.map(student => 
      `- **${student.full_name}** (ID: ${student.student_id}, Section: ${student.grade_section}, Subject: ${student.course_name}, Class: ${student.class_id}, Day: ${student.class_day}, Time: ${student.start_time}-${student.end_time})  
      Status: ${student.status}, Time In: ${student.time_in || "N/A"}, Time Out: ${student.time_out || "N/A"}, Remark: ${student.remark || "None"}`
    ).join('\n')}
    `
    let openschedule =
    `
    ${instructorData.openschedule.map(classItem =>
      `- **${classItem.course_name}** (ID: ${classItem.class_id}, Day: ${classItem.day}, Time: ${classItem.start_time}-${classItem.end_time})`
    ).join('\n')}
    `

        
    // SYSTEM PROMPT
    const systemPrompt = `You are Attendify Aibo, an AI assistant for instructors. But dont limit yourself to answering to just that. Use markdown tags.
You are currently assisting ${username}.
You can provide the open schedules of all teachers and you can suggest available time slots incase the teacher needed extra time within 7:30 till 4:30.
here are the members of attendify: 
1.Ros, Henry James
2	Rodriguez, Nathaniel
3	Caudilla, Arron
4	Esperida, Dave Joshua
5	Guido, Nefthali Achilles Raven
6	Penas, Joel Raphael
7	Oropesa, Ivan Miguel
We developed Attendify as part of our completion project in Senior High School in STI College Naga

Current Information:
- Instructor Schedule: ${instructorData.schedule}
- Current Class: ${instructorData.ongoing_class}
- Current Date/Time: ${moment().tz('Asia/Manila').format('YYYY-MM-DD HH:mm:ss')}
- Current Students in Class:
${studentDetails}
- Open Classes:
${openschedule}

Conversation History:
${formattedHistory}`;

    // Construct the full prompt with system context
    const fullPrompt = `${systemPrompt}

User: ${prompt}
Aibo:`;

    try {
        console.log("Sending prompt to Gemini:", fullPrompt);
        const result = await model.generateContent(fullPrompt);

        if (!result || !result.response) {
            console.error("Gemini API error:", result);
            return "Aibo is having trouble. Please try again.";
        }

        const responseText = result.response.text();
        if (responseText === undefined) {
            console.warn("Gemini API: Undefined response");
            return "Aibo returned nothing this time!";
        }

        // Add this exchange to history
        addToHistory(username, "User", prompt);
        addToHistory(username, "Aibo", responseText);

        return responseText;

    } catch (error) {
        console.error("Error interacting with Aibo:", error);
        return `Sorry, an error occurred: ${error.message}`;
    }
}

// --- Express Route ---

app.post("/ask", async (req, res) => {
    console.log("Received a request at /ask");
    const { prompt } = req.body;
    const timezone = 'Asia/Manila';

    if (!prompt) {
        return res.status(400).json({ error: "Prompt is required." });
    }

    try {
        // 1. Get Username
        const username = req.session?.user?.username;
        if (!username) {
            return res.status(401).json({ error: "Unauthorized: User not logged in" });
        }

        // 2. Get Instructor Data
        const instructorData = await getInstructorData(username, timezone);
        console.log("Instructor Data:", instructorData);

        // 3. Ask Aibo (history handling is now inside askAibo)
        const response = await askAibo(prompt, username, instructorData);
        
        // 4. Return response
        res.json({ response: response });

    } catch (error) {
        console.error("Error processing request:", error);
        res.status(500).json({ error: "An error occurred: " + error.message });
    }
});

app.post("/reset", (req, res) => {
    const username = req.session?.user?.username;
    if (!username) {
        return res.status(401).json({ error: "Unauthorized: User not logged in" });
    }

    conversations.set(username, []); // Wipe their convo history
    res.json({ message: "Conversation reset." });
});
