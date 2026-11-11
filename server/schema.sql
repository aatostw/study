-- 學習筆記：資料表（啟動時自動建立，重複執行也安全）
CREATE EXTENSION IF NOT EXISTS vector;

-- 設定：每項工作的模型、AI 金鑰（金鑰只存在這台電腦）
CREATE TABLE IF NOT EXISTS settings (
  k text PRIMARY KEY,
  v jsonb NOT NULL
);

-- 書：只有筆記的書，或附上 PDF/EPUB 原文的書
CREATE TABLE IF NOT EXISTS books (
  id bigserial PRIMARY KEY,
  title text NOT NULL,
  author text NOT NULL DEFAULT '',
  file_name text NOT NULL DEFAULT '',
  file_path text NOT NULL DEFAULT '',
  pages int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'ready',      -- ready / queued / indexing / error
  analysis jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 讀書筆記：原文摘句 + 自己的想法，帶章節與頁碼
CREATE TABLE IF NOT EXISTS notes (
  id bigserial PRIMARY KEY,
  book_id bigint NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  quote text NOT NULL DEFAULT '',
  content text NOT NULL DEFAULT '',
  chapter text NOT NULL DEFAULT '',
  page text NOT NULL DEFAULT '',
  source text NOT NULL DEFAULT 'typed',      -- typed / photo
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notes_book ON notes(book_id);

-- 課程：一堂課一筆
CREATE TABLE IF NOT EXISTS lectures (
  id bigserial PRIMARY KEY,
  course text NOT NULL DEFAULT '',
  title text NOT NULL,
  lang text NOT NULL DEFAULT 'zh',            -- zh / en / auto
  terms text NOT NULL DEFAULT '',             -- 課程術語，給 Whisper 當提示
  file_name text NOT NULL DEFAULT '',
  media_path text NOT NULL DEFAULT '',
  audio_path text NOT NULL DEFAULT '',
  duration real NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'queued',      -- queued / processing / ready / error
  summary jsonb,
  summary_model text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 逐字稿：Whisper 的每一段，帶時間
CREATE TABLE IF NOT EXISTS segments (
  id bigserial PRIMARY KEY,
  lecture_id bigint NOT NULL REFERENCES lectures(id) ON DELETE CASCADE,
  idx int NOT NULL,
  t0 real NOT NULL,
  t1 real NOT NULL,
  text text NOT NULL
);
CREATE INDEX IF NOT EXISTS segments_lecture ON segments(lecture_id, idx);

-- 知識庫的最小單位：筆記、書的段落、課程的一小段，都轉成向量
CREATE TABLE IF NOT EXISTS chunks (
  id bigserial PRIMARY KEY,
  kind text NOT NULL,                          -- note / book / lecture
  book_id bigint REFERENCES books(id) ON DELETE CASCADE,
  note_id bigint REFERENCES notes(id) ON DELETE CASCADE,
  lecture_id bigint REFERENCES lectures(id) ON DELETE CASCADE,
  page text NOT NULL DEFAULT '',
  chapter text NOT NULL DEFAULT '',
  t0 real,
  t1 real,
  text text NOT NULL,
  embedding vector(1024)
);
CREATE INDEX IF NOT EXISTS chunks_book ON chunks(book_id);
CREATE INDEX IF NOT EXISTS chunks_note ON chunks(note_id);
CREATE INDEX IF NOT EXISTS chunks_lecture ON chunks(lecture_id);
CREATE INDEX IF NOT EXISTS chunks_embedding ON chunks USING hnsw (embedding vector_cosine_ops);

-- 背景工作：課程處理、PDF/EPUB 索引、書籍分析、重新摘要
CREATE TABLE IF NOT EXISTS jobs (
  id bigserial PRIMARY KEY,
  kind text NOT NULL,                          -- lecture / bookfile / analyze / resummarize
  ref_id bigint NOT NULL,
  title text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'queued',       -- queued / running / done / error
  step text NOT NULL DEFAULT '',
  progress real NOT NULL DEFAULT 0,
  error text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status, id);

-- 問答紀錄
CREATE TABLE IF NOT EXISTS asks (
  id bigserial PRIMARY KEY,
  question text NOT NULL,
  scope text NOT NULL DEFAULT 'all',
  answer text NOT NULL DEFAULT '',
  sources jsonb NOT NULL DEFAULT '[]',
  model text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
