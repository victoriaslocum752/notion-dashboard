const express = require("express");
var cookieSession = require("cookie-session");

const fetch = require("node-fetch");

// our module
const moduleToFetch = require("./getNotion");

// const database = require("./getFirebase");
var admin = require("firebase-admin");
require("dotenv").config();

// grab the firebase credentials from an environment variable
// the environment variable is a base64 encoded ServiceAccount object
let theCreds = admin.credential.cert(
  JSON.parse(
    Buffer.from(process.env.FIREBASE_CONFIG, "base64").toString("utf-8")
  )
);

admin.initializeApp({
  credential: theCreds,
  databaseURL: process.env.FIREBASE_DATABASE_URL,
});

let database = admin.database();

const { Client } = require("@notionhq/client");
const notion = new Client();

// this line initializes the Notion Client using our key
// user module (get token and data)

// our function

const nunjucks = require("nunjucks");

const getDatabase = moduleToFetch.getDatabase;

const port = 8000;

let redirect_uri = "";

if (process.env.NODE_ENV == "development") {
  redirect_uri = "http://localhost:8000/auth_callback";
} else {
  // a DOMAIN env var is required for production
  redirect_uri = process.env.DOMAIN + "/auth_callback";
}

const app = express();

app.use(express.static("public"));

// necessary to set session cookies
app.use(
  cookieSession({
    name: "session",
    keys: ["token"],

    // Cookie Options
    maxAge: 720 * 60 * 60 * 1000, // 1 month
  })
);

// middleware to see if the user is logged in and add their user data to the req
var getUser = async (req, res, next) => {
  if (req.session.access_token) {
    // look up the user in firebase
    const ref = database.ref(`/users/${req.session.access_token}`);
    const response = await ref.once("value");
    const user = response.val();

    if (user) {
      req.user = user;
    } else {
      // user is not in firebase

      // remove the invalid access token
      req.session.access_token = null;
    }
  } else {
    req.user = null;
  }

  // basically, all routes will get a req.user property now
  next();
};

app.use(getUser);

nunjucks.configure("views", {
  autoescape: true,
  express: app,
});

app.get("/users", async (req, res) => {
  const users = await getDatabase();
  res.json(users);
});

app.get("/", async (req, res) => {
  res.render("pages/landing.nj", { loggedIn: req.user ? true : false });
});

app.get("/onboarding", async (req, res) => {
  res.render("pages/onboarding.nj", { foo: "bar" });
});

app.get("/settings", async (req, res) => {
  // grab list of notion pages

  // logged in users only
  if (!req.user) {
    res.redirect("/");
    return;
  }

  // will contain list of databases found//////
  let databases = [];
  // may contain guesses for what the tasks and goals db is
  let tasksGuess,
    goalsGuess = "";

  try {
    const queryDatabases = await notion.search({
      query: "",
      filter: { property: "object", value: "database" },
      auth: req.user.notionData.access_token,
    });

    console.log(req.user.notionData.access_token);

    const databasesFound = queryDatabases.results;

    // if (databasesFound.length < 2) {
    //   // log out the user
    //   req.session.access_token = null;

    //   throw new Error(
    //     `You need at least two databases in the pages you added. Only found ${databasesFound.length}<br /><br /><a href="/auth">Log in again</a>`
    //   );
    // }

    // console.log(databasesFound[0].title);

    // map these databases into a prettier array
    databases = databasesFound.map((db) => {
      return {
        id: db.id,
        // display the emoji, if exists. if picture or blank, show nothing
        emoji: db.icon && db.icon.type == "emoji" ? db.icon.emoji : "",
        // name if the database
        name: db.title[0] ? db.title[0].plain_text : "unknown title",
      };
    });

    // console.log(databases);

    // make some guesses into what the tasks and goals database is
    tasksGuess = databases.find(
      (db) =>
        db.name.toLowerCase().includes("to-do") ||
        db.name.toLowerCase().includes("task") ||
        db.name.toLowerCase().includes("todo")
    );
    goalsGuess = databases.find(
      (db) =>
        db.name.toLowerCase().includes("epic") ||
        db.name.toLowerCase().includes("goal")
    );
  } catch (error) {
    // TODO: use error handling within the template, not a white page
    res.send(error.toString());
    console.log("error", error);
    return;
  }

  res.render("pages/settings.nj", {
    databases,
    // return the database ID if our guess found a result
    tasksGuessId: tasksGuess ? tasksGuess.id : "",
    goalsGuessId: goalsGuess ? goalsGuess.id : "",
  });
});

app.get("/auth", async (req, res) => {
  if (req.user) {
    res.redirect("/dashboard");
  } else {
    const notion_link = `https://api.notion.com/v1/oauth/authorize?client_id=${process.env.NOTION_CLIENT_ID}&redirect_uri=${redirect_uri}&response_type=code`;
    res.redirect(notion_link);
  }
});

app.get("/logout", async (req, res) => {
  req.session.access_token = null;
  res.redirect("/auth");
});

app.get("/dashboard", async (req, res) => {
  if (!req.user.pages) {
    // if they don't have any pages added, take them to the config page
    res.redirect("/settings");
    return;
  }

  res.send("coming soon");
});

app.get("/auth_callback", async (req, res) => {
  // we have a temporary code (req.query.code), but we need to get an
  // access token

  const authorization = `${process.env.NOTION_CLIENT_ID}:${process.env.NOTION_CLIENT_SECRET}`;

  // // base64 encode it lol
  const auth_base64 = Buffer.from(authorization).toString("base64");

  const access_token = await fetch("https://api.notion.com/v1/oauth/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth_base64}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code: req.query.code,
      redirect_uri: "http://localhost:8000/auth_callback",
    }),
  });

  let userData = await access_token.json();

  console.log("we now know", userData.access_token);

  // add this user to database, if it doesn't exist
  try {
    // look up the user based on their access_token
    const ref = database.ref(`/users/${userData.access_token}`);
    const response = await ref.once("value");
    const user = response.val();

    if (!user) {
      // add the user to the database
      await ref.set({ notionData: userData, dashboardPages: [] });
    }

    console.log(userData.access_token);

    // set a cookie with their access token so they don't need to log in again
    req.session.access_token = userData.access_token;
  } catch (err) {
    console.error(err);
    res.send("An error occurred", err);
    return;
  }

  res.redirect("/dashboard");
});

app.listen(port, console.log(`Server started on ${port}`));
