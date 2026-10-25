import index from "../client/index.html";
import { AnnotationStore } from "./annotations";
import { createServer } from "./api";
import { Catalog } from "./catalog";
import { loadConfig } from "./config";
import { openDatabase } from "./db";
import { TranscriptStore } from "./transcripts";

const config = loadConfig();
const db = openDatabase(config.dbPath);
const catalog = new Catalog(db, config);
const transcripts = new TranscriptStore(config, catalog);
const annotations = new AnnotationStore(db);

const server = createServer(
  { catalog, transcripts, annotations },
  { port: config.port, hostname: config.hostname, development: config.development, html: index },
);

console.log(`marginalia listening on ${server.url}`);
console.log(`annotations database: ${config.dbPath}`);

catalog.refresh().catch((err) => {
  console.error("[catalog] initial refresh failed:", err);
});
