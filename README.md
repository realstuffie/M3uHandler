# m3uHandler

A command-line utility to process M3U/M3U8 playlists and organize their entries into structured `.strm` files for media servers.

## Overview

This tool parses a master M3U playlist and categorizes each entry into `Movies`, `TV Shows`, or `Live` streams. It then creates a directory structure and writes individual `.strm` files, which are recognized by many media server applications.

-   Movies are organized by year (e.g., `Movies/2023/My Movie.strm`).
-   TV shows are organized by show name and season (e.g., `TV Shows/My Show/Season 01/S01E01 - Pilot.strm`). Treats the TV shows URL as multiple paginated links.
-   Live streams are typically ignored unless specified.

## Prerequisites

-   Node.js version 18 or higher.

## Installation

1.  Clone the repository.
2.  Install dependencies:
    ```bash
    npm install
    ```
    *(Note: The project contains a custom `install-deps.js` script, but `npm install` should suffice for standard setups.)*

## Usage
This Tool is designed to be used with ApolloGroupTV M3U files, But may work for other providers.
The primary way to use this tool is via the command-line interface.

```bash
node src/index.js --input <playlist.m3u8> [options]
```

### Options

| Flag                 | Alias | Description                                               | Default     |
| -------------------- | ----- | --------------------------------------------------------- | ----------- |
| `--input <file>`     | `-i`  | **Required.** The path to the input M3U/M3U8 playlist file. |             |
| `--out <dir>`        | `-o`  | The root directory for the generated output folders.      | `output`    |
| `--include-live`     |       | Also write `.strm` files for live stream entries.         | `false`     |
| `--overwrite`        |       | Overwrite existing `.strm` files if they already exist.   | `false`     |
| `--dry-run`          |       | Analyze and report what would be written without saving.  | `false`     |
| `--movies-flat`      |       | Put movies directly under `Movies/` instead of `Movies/<Year>/`. | `false`   |
| `--help`             | `-h`  | Display the help message.                                 |             |


## Available Scripts

You can use `npm run <script-name>` to execute the following commands:

-   `npm run cli`: The main script to process a playlist. Equivalent to `node src/index.js`.
-   `npm run daemon`: Runs the application in daemon mode to watch for changes.
-   `npm run config`: Executes a configuration management script.