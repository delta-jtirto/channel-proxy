-- Add html_body column to messages table for rich email rendering
ALTER TABLE messages ADD COLUMN IF NOT EXISTS html_body TEXT;
