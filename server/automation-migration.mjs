import { chmodSync } from "node:fs";
export function migrateAutomation(db, path) {
  const version = db.prepare("PRAGMA user_version").get().user_version;
  if (version >= 3) return;
  if (
    path !== ":memory:" &&
    db.prepare("SELECT count(*) n FROM documents").get().n
  ) {
    const snapshot = path + ".pre-v3-" + Date.now() + ".sqlite";
    db.prepare("VACUUM INTO ?").run(snapshot);
    chmodSync(snapshot, 0o600);
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
 CREATE TABLE sales_opportunities(id TEXT PRIMARY KEY,client_id TEXT NOT NULL REFERENCES clients(id),title TEXT NOT NULL,description TEXT NOT NULL,stage TEXT NOT NULL CHECK(stage IN ('new','qualified','quoted','won','lost')),expected_amount INTEGER NOT NULL,quote_id TEXT UNIQUE REFERENCES documents(id),created TEXT NOT NULL,updated TEXT NOT NULL);
 CREATE TABLE customer_pos(id TEXT PRIMARY KEY,client_id TEXT NOT NULL REFERENCES clients(id),quote_id TEXT NOT NULL UNIQUE REFERENCES documents(id),reference TEXT NOT NULL,reference_key TEXT NOT NULL,amount INTEGER NOT NULL,po_date TEXT NOT NULL,notes TEXT NOT NULL,invoice_id TEXT UNIQUE REFERENCES documents(id),created TEXT NOT NULL,UNIQUE(client_id,reference_key));
 CREATE TABLE automation_proposals(id TEXT PRIMARY KEY,kind TEXT NOT NULL,payload TEXT NOT NULL,source TEXT NOT NULL,request_key TEXT NOT NULL,fingerprint TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','applied','rejected')),result TEXT,reason TEXT,created TEXT NOT NULL,expires INTEGER NOT NULL,reviewed TEXT,UNIQUE(source,request_key));
 CREATE TABLE integration_tokens(id TEXT PRIMARY KEY,label TEXT NOT NULL,hash TEXT NOT NULL UNIQUE,scopes TEXT NOT NULL,expires INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,created TEXT NOT NULL,last_used TEXT);
 CREATE TABLE automation_events(id INTEGER PRIMARY KEY AUTOINCREMENT,type TEXT NOT NULL,entity_id TEXT NOT NULL,payload TEXT NOT NULL,created TEXT NOT NULL,processed INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE automation_rules(id TEXT PRIMARY KEY,enabled INTEGER NOT NULL DEFAULT 0,enabled_after INTEGER NOT NULL DEFAULT 0);
 INSERT INTO automation_rules VALUES('accepted_quote_review',0,0),('customer_po_invoice',0,0);
 CREATE TABLE automation_runs(id TEXT PRIMARY KEY,event_id INTEGER NOT NULL REFERENCES automation_events(id),rule_id TEXT NOT NULL REFERENCES automation_rules(id),state TEXT NOT NULL,result TEXT,error TEXT,created TEXT NOT NULL,UNIQUE(event_id,rule_id));
 CREATE TABLE assistant_runs(id TEXT PRIMARY KEY,owner_id INTEGER NOT NULL REFERENCES owners(id),request_key TEXT NOT NULL,prompt TEXT NOT NULL,response TEXT,state TEXT NOT NULL,tool_log TEXT NOT NULL DEFAULT '[]',created TEXT NOT NULL,UNIQUE(owner_id,request_key));
 CREATE INDEX automation_pending_idx ON automation_events(processed,id);
 PRAGMA user_version=3; COMMIT;`);
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
