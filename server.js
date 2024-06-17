const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const mysql = require("mysql2");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const moment = require("moment");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(bodyParser.json());

// Database connection setup
const connection = mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
});

connection.connect((err) => {
  if (err) {
    console.error("Error connecting to MySQL:", err);
    return;
  }
  console.log("Connected to MySQL database.");
});

app.post("/api/login", async (req, res) => {
  const { username, password, selectedBike } = req.body;

  // Step 1: Validate inputs
  if (!username || !password || !selectedBike) {
    return res
      .status(400)
      .json({ error: "Username, password, and bikeId are required." });
  }

  try {
    // Step 2: Retrieve user from database
    const query = "SELECT * FROM employees WHERE username = ? AND password = ?";
    connection.query(query, [username, password], async (error, results) => {
      if (error) {
        console.error("Error fetching employee:", error);
        return res.status(500).json({ error: "Failed to fetch employee." });
      }

      // Step 3: Check if user exists and verify password
      if (results.length === 0) {
        return res
          .status(401)
          .json({ error: "Username or password is incorrect." });
      }

      try {
        const user = results[0];
        // Step 4: Generate JWT token without expiresIn
        const token = jwt.sign(
          { id: user.id, username: user.username, role: user.role },
          process.env.JWT_SECRET
        );

        // Step 5: Store token in database
        const updateQuery = "UPDATE employees SET token = ? WHERE id = ?";
        connection.query(
          updateQuery,
          [token, user.id],
          (updateError, updateResults) => {
            if (updateError) {
              console.error("Error storing token:", updateError);
              return res.status(500).json({ error: "Failed to store token." });
            }

            // Step 6: Insert login record into assembly_records table with bikeId
            const insertQuery =
              "INSERT INTO assembly_records (employee_id, bike_id, role, active_login,logged_in_time) VALUES (?, ?, ?,?, CURRENT_TIMESTAMP)";
            connection.query(
              insertQuery,
              [user.id, selectedBike, user?.role, true],
              (insertError, insertResults) => {
                if (insertError) {
                  console.error("Error inserting record:", insertError);
                  return res
                    .status(500)
                    .json({ error: "Failed to insert record." });
                }
                // Step 7: Send token in response
                res.json({ token });
              }
            );
          }
        );
      } catch (error) {
        console.error("Error handling login process:", error);
        res
          .status(500)
          .json({ error: "Login failed. Please try again later." });
      }
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Login failed. Please try again later." });
  }
});

app.post("/api/logout", async (req, res) => {
  const { employeeId } = req.body;

  try {
    // Step 1: Identify the active login session
    const selectQuery = `
      SELECT id, logged_in_time
      FROM assembly_records
      WHERE employee_id = ? AND active_login = ?
        AND logged_out_time IS NULL
      ORDER BY logged_in_time DESC
      LIMIT 1`;

    connection.query(
      selectQuery,
      [employeeId, true],
      (selectError, selectResults) => {
        if (selectError) {
          console.error("Error selecting active login session:", selectError);
          return res.status(500).json({ error: "Failed to logout." });
        }

        if (selectResults.length === 0) {
          return res
            .status(404)
            .json({ error: "No active login session found." });
        }

        const { id, logged_in_time } = selectResults[0];
        const updateQuery = `
        UPDATE assembly_records
SET 
    logged_out_time = CURRENT_TIMESTAMP,
    logged_duration = CASE 
                         WHEN role = 'employee' THEN TIMEDIFF(CURRENT_TIMESTAMP, ?)
                         ELSE logged_duration  -- Keep existing value if not 'employee'
                     END,
    active_login = false
WHERE 
    id = ?`;

        connection.query(
          updateQuery,
          [logged_in_time, id],
          (updateError, updateResults) => {
            if (updateError) {
              console.error(
                "Error updating active login session:",
                updateError
              );
              return res.status(500).json({ error: "Failed to logout." });
            }
            res.status(200).json({ message: "Logout successful." });
          }
        );
      }
    );
  } catch (error) {
    console.error("Logout error:", error);
    res.status(500).json({ error: "Logout failed. Please try again later." });
  }
});
app.post("/api/postbikeId", (req, res) => {
  const { bikeId, employeeId } = req.body;

  const updateQuery = `
    UPDATE assembly_records
    SET bike_id = ?
    WHERE employee_id = ? AND active_login = 1
  `;

  connection.query(
    updateQuery,
    [bikeId, employeeId],
    (error, results, fields) => {
      if (error) {
        console.error("Error updating bike ID:", error);
        res.status(500).json({ error: "Failed to update bike ID." });
        return;
      }
      res.status(201).json({ message: "Bike ID updated successfully." });
    }
  );
});
app.get("/api/employees", (req, res) => {
  connection.query("SELECT * FROM employees", (error, results) => {
    if (error) {
      console.error("Error fetching employees:", error);
      res.status(500).json({ error: "Failed to fetch employees" });
      return;
    }
    res.json(results);
  });
});
app.get("/api/bikes", (req, res) => {
  connection.query("SELECT * FROM bikes", (error, results) => {
    if (error) {
      console.error("Error fetching bikes:", error);
      res.status(500).json({ error: "Failed to fetch bikes" });
      return;
    }
    res.json(results);
  });
});
app.get("/api/assemble", (req, res) => {
  connection.query("SELECT * FROM assembly_records", (error, results) => {
    if (error) {
      console.error("Error fetching assembly records:", error);
      res.status(500).json({ error: "Failed to fetch assembly records" });
      return;
    }
    res.json(results);
  });
});
app.get("/api/employee/production", (req, res) => {
  const { fromDate, toDate } = req.query;
  const query = `
  SELECT bike_id,
  SEC_TO_TIME(SUM(TIME_TO_SEC(logged_duration))) AS total_logged_duration
FROM 
  assembly_records
WHERE 
  logged_out_time IS NOT NULL 
  AND DATE(logged_in_time) BETWEEN '${fromDate}' AND '${toDate}'
  AND DATE(logged_out_time) BETWEEN '${fromDate}' AND '${toDate}'
  AND role = "employee" GROUP BY bike_id;
  `;
  connection.query(query, (error, results, fields) => {
    if (error) {
      console.error("Error fetching total logged duration:", error);
      return res
        .status(500)
        .json({ error: "Failed to fetch total logged duration." });
    }

    if (results.length === 0 || results[0].total_logged_duration === null) {
      return res.status(404).json({
        error: "No logged duration found for the specified period.",
      });
    }
    res.json(results);
  });
});

app.get("/api/employee/specificDateProduction", (req, res) => {
  const { specificDate } = req.query;

  try {
    const query = `
    SELECT bike_id,
    SEC_TO_TIME(SUM(TIME_TO_SEC(logged_duration))) AS total_logged_duration
  FROM 
    assembly_records
  WHERE 
  role = "employee" AND 
    logged_out_time IS NOT NULL 
    AND DATE(logged_in_time) = '${specificDate}' GROUP BY bike_id;`;
    connection.query(query, (error, results) => {
      if (error) {
        console.error("Error fetching total logged duration:", error);
        return res
          .status(500)
          .json({ error: "Failed to fetch total logged duration." });
      }
      res.json(results);
    });
  } catch (error) {
    console.error("Error formatting date or executing query:", error);
    res.status(500).json({
      error: "Failed to fetch total logged duration. Please try again later.",
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
