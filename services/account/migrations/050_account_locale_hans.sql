-- Stored interface preferences use the BCP 47 script tag for Simplified Chinese.
UPDATE public."user" SET locale = 'zh-Hans' WHERE locale = 'zh-CN';
