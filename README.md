# 🎬 CineRank — Now Playing Movies

🇧🇷 [Clique aqui para ler a versão em Português (Brasil)](README-PTbr.md)

**Access the live project:** [https://alexsami-lopes.github.io/tmdb-scraper/](https://alexsami-lopes.github.io/tmdb-scraper/)

CineRank is an interactive and responsive dashboard focused on ranking and tracking the evolution of movies currently playing in theaters. The project displays trends, scores, rating history, and a detailed visual tracking of the movies' ups and downs in the "Top 20" over time.

---

## 🏗️ Architecture and Tech Stack

The project was built using a lightweight and accessible *Serverless* architecture, utilizing the Google ecosystem as the backend.

* **Frontend:** HTML5, pure CSS3 (with variables and responsive design), and Vanilla JavaScript. No heavy UI libraries were used, ensuring high performance.
* **Data Visualization:** Chart.js (featuring custom plugins that draw directly onto the Canvas).
* **Backend / API:** Google Apps Script (`Code.gs`). The script acts as a REST API consumed by the frontend and fed by the scraper.
* **Database:** Google Sheets. The spreadsheet serves as the central repository where historical data, cast details, and execution logs are structurally stored.

---

## ⚙️ Data Collection & Integration (TMDB Scraping)

Data is not inserted manually. An automated scraper fetches data from the TMDB (The Movie Database) API, focusing on the *Now Playing* category.

This data is sent via a `POST` request to our backend (Google Apps Script), which stores the following essential information: ID, Title, Poster, Score, Genres, and Cast. The daily storage creates a chronological snapshot of the box office.

---

## 💻 Backend: How `Code.gs` works

The `Code.gs` file is the heart of the project. It runs on Google Apps Script attached to a spreadsheet and intercepts HTTP requests (`doGet` and `doPost`).

* **POST:** Receives the data payload from the scraper. It validates security through a `SECRET` environment variable, creates the sheets (`filmes`, `elenco`, `runs`) if they don't exist, deduplicates entries to avoid repeating movies on the same day, saves the data, and clears the cache.
* **GET:** Provides processed data to the frontend. It features routes for search (`?action=search`), history (`?action=history`), ranking, and trends. It uses Google's `CacheService` (5-minute TTL) to ensure the dashboard loads blazingly fast without overloading the spreadsheet.

### 🛠️ How to run the Backend on your Google Drive

If you want to clone and run your own version of this API, follow these steps:

1. **Create the Spreadsheet:** Create a new blank spreadsheet in [Google Sheets](https://sheets.google.com).
2. **Open the Script:** In the top menu, go to `Extensions` > `Apps Script`.
3. **Paste the Code:** Delete the default code (`function myFunction() {}`) and paste the entire content of the `Code.gs` file.
4. **Configure the Environment Variable (SECRET):**
   * In the left sidebar of Apps Script, click the gear icon (Project Settings).
   * Scroll down to the **Script properties** section and click **Add script property**.
   * Under *Property*, type exactly `SECRET`.
   * Under *Value*, type a secure password of your choice (e.g., `my_super_secret_password_123`).
   * Save the script properties. *(Note: The scraper you use to send data via POST will need to include this exact same secret in the request body).*
5. **Deploy the API:**
   * Click the blue **Deploy** button in the top right corner > **New deployment**.
   * Select the **Web app** type.
   * Under *Execute as*, select `Me`.
   * Under *Who has access*, select `Anyone` (necessary for the public frontend to read the data).
   * Click **Deploy**. Authorize permissions in your Google account when prompted.
   * Copy the **Web app URL**. You must paste this URL into the `API` constant inside your frontend's `index.html`.

---

## 🖥️ Interface and Features (UI/UX)

The interface was designed with a *premium* look (dark background, serif fonts, and gold accents) and features the following sections:

* **Header and Date Selector:** Allows the user to navigate through time, picking past dates to see how the ranking looked. Includes local caching via `sessionStorage`.
* **Hero Section:** An automatic rotating highlight of the day's top-rated movies, displaying full-screen posters.
* **Top 10 Highest Rated & Top 20 Now Playing:** Visually ranked lists, progress bars, and a dynamic grid of movie cards.
* **Movie History & Trends:** A search bar that returns a movie's timeline and a mini-chart showing its rating evolution, plus a persistence list showing how many consecutive days movies have stayed in theaters.
* **Evolution (Main Chart):** An advanced line chart built with Chart.js showing the "Top 20" evolution over the last 10 days.
    * *UX/UI Innovations:* Movie posters are drawn as rounded images directly onto the canvas; mathematical responsive scaling (dynamic `rowHeight`) to prevent overlapping text; native click and hover events tied to invisible hitboxes.
* **Details Modal:** Displays rich details when clicking any movie, fetching even the cast's profile pictures.