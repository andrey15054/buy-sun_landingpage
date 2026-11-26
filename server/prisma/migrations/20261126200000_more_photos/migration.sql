-- Two more extra photos: the photo page of the anketa holds four (full body and three more)
ALTER TYPE "FileKind" ADD VALUE IF NOT EXISTS 'additional2';
ALTER TYPE "FileKind" ADD VALUE IF NOT EXISTS 'additional3';
