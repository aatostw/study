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

-- ===== 選書評估（想讀的書）=====
ALTER TABLE books ADD COLUMN IF NOT EXISTS shelf text NOT NULL DEFAULT 'read';   -- read（我的書）/ wish（想讀）
ALTER TABLE books ADD COLUMN IF NOT EXISTS isbn text NOT NULL DEFAULT '';
ALTER TABLE books ADD COLUMN IF NOT EXISTS wish_note text NOT NULL DEFAULT '';   -- 為什麼想讀
ALTER TABLE books ADD COLUMN IF NOT EXISTS user_evidence text NOT NULL DEFAULT ''; -- 自己補的資料（例如微信讀書截圖辨識的文字）
ALTER TABLE books ADD COLUMN IF NOT EXISTS evaluation jsonb;

-- 抓過的網頁（存 7 天，同一個網頁不重複抓）
CREATE TABLE IF NOT EXISTS web_cache (
  url text PRIMARY KEY,
  ok boolean NOT NULL,
  text text NOT NULL DEFAULT '',
  why text NOT NULL DEFAULT '',
  fetched_at timestamptz NOT NULL DEFAULT now()
);

-- 一體化：記事本（不屬於任何書的獨立筆記）、收藏
ALTER TABLE notes ALTER COLUMN book_id DROP NOT NULL;
ALTER TABLE notes ADD COLUMN IF NOT EXISTS title text NOT NULL DEFAULT '';
ALTER TABLE notes ADD COLUMN IF NOT EXISTS starred boolean NOT NULL DEFAULT false;
ALTER TABLE books ADD COLUMN IF NOT EXISTS starred boolean NOT NULL DEFAULT false;
ALTER TABLE lectures ADD COLUMN IF NOT EXISTS starred boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS notes_free ON notes(updated_at DESC) WHERE book_id IS NULL;

-- 助理：對話（一串對話有很多則訊息；評估一本書也會變成對話裡的一張卡片）
CREATE TABLE IF NOT EXISTS chats (
  id bigserial PRIMARY KEY,
  title text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS chat_msgs (
  id bigserial PRIMARY KEY,
  chat_id bigint NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role text NOT NULL,                        -- user / assistant
  content text NOT NULL DEFAULT '',
  scope text NOT NULL DEFAULT 'all',
  sources jsonb NOT NULL DEFAULT '[]',
  card jsonb,                                -- 例如 {"type":"eval","book_id":3}
  model text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_msgs_chat ON chat_msgs(chat_id, id);

-- 把以前「問答」的紀錄搬進助理的對話（只做一次）
DO $$
DECLARE r record; cid bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM settings WHERE k = 'chats_migrated') THEN
    FOR r IN SELECT * FROM asks WHERE scope NOT LIKE 'book:%' AND scope NOT LIKE 'lecture:%' ORDER BY id LOOP
      INSERT INTO chats (title, created_at, updated_at) VALUES (left(r.question, 40), r.created_at, r.created_at) RETURNING id INTO cid;
      INSERT INTO chat_msgs (chat_id, role, content, scope, created_at) VALUES (cid, 'user', r.question, r.scope, r.created_at);
      INSERT INTO chat_msgs (chat_id, role, content, scope, sources, model, created_at) VALUES (cid, 'assistant', r.answer, r.scope, r.sources, r.model, r.created_at);
    END LOOP;
    INSERT INTO settings (k, v) VALUES ('chats_migrated', 'true');
  END IF;
END $$;

-- 知識複習：每週一篇（週一～週日；週日早上 7 點自動做到週六為止，也可以隨時手動做「本週至今」）
CREATE TABLE IF NOT EXISTS reviews (
  id bigserial PRIMARY KEY,
  week_start date NOT NULL UNIQUE,            -- 那一週的星期一
  range_end timestamptz NOT NULL,             -- 資料算到什麼時候
  auto boolean NOT NULL DEFAULT false,        -- 週日早上自動產生的
  status text NOT NULL DEFAULT 'queued',      -- queued / ready / error / empty
  content jsonb,
  model text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 書的狀態：想讀 → 在讀 → 讀完（以前的 'read' 改叫 'reading'）
UPDATE books SET shelf = 'reading' WHERE shelf = 'read';
ALTER TABLE books ALTER COLUMN shelf SET DEFAULT 'wish';
-- 想讀的書：記了第一則筆記、或上傳了原文，自動變「在讀」
CREATE OR REPLACE FUNCTION book_auto_reading() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'notes' THEN
    IF NEW.book_id IS NOT NULL THEN
      UPDATE books SET shelf = 'reading' WHERE id = NEW.book_id AND shelf = 'wish';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.file_name <> '' AND COALESCE(OLD.file_name, '') = '' AND NEW.shelf = 'wish' THEN
    NEW.shelf := 'reading';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS notes_auto_reading ON notes;
CREATE TRIGGER notes_auto_reading AFTER INSERT ON notes FOR EACH ROW EXECUTE FUNCTION book_auto_reading();
DROP TRIGGER IF EXISTS books_auto_reading ON books;
CREATE TRIGGER books_auto_reading BEFORE UPDATE OF file_name ON books FOR EACH ROW EXECUTE FUNCTION book_auto_reading();

-- 助理：每則回答留下這次的候選資料，追問時跟新搜到的一起重新排名
ALTER TABLE chat_msgs ADD COLUMN IF NOT EXISTS pool jsonb;

-- 記事本：可以設成「不放進知識庫」（例如測驗題、草稿），助理和知識複習都不會用到
ALTER TABLE notes ADD COLUMN IF NOT EXISTS no_index boolean NOT NULL DEFAULT false;

-- 筆記的向量文字加上書名、章節（以前只有內容，問「《某本書》第一章」找不到）：清掉舊向量讓背景重建一次
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM settings WHERE k = 'notes_text_v2') THEN
    DELETE FROM chunks WHERE note_id IS NOT NULL;
    INSERT INTO settings (k, v) VALUES ('notes_text_v2', 'true');
  END IF;
END $$;

-- 助理：「指定」的書／筆記／課程，跟著這段對話
ALTER TABLE chats ADD COLUMN IF NOT EXISTS pins jsonb NOT NULL DEFAULT '[]';

-- 書的封面：存在 data/covers/{id}.jpg。cover = 版本號（換封面時變，App 才會重抓）；
-- cover_src：google / openlibrary / search / photo；cover_mode：auto（自動找）／photo（用我拍的）／text（文字封面）
ALTER TABLE books ADD COLUMN IF NOT EXISTS cover text NOT NULL DEFAULT '';
ALTER TABLE books ADD COLUMN IF NOT EXISTS cover_src text NOT NULL DEFAULT '';
ALTER TABLE books ADD COLUMN IF NOT EXISTS cover_mode text NOT NULL DEFAULT 'auto';
ALTER TABLE books ADD COLUMN IF NOT EXISTS cover_tried boolean NOT NULL DEFAULT false;
