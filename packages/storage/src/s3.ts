// packages/storage/src/s3.ts
// Public S3 helper surface. Implementations should live here so other
// packages can rely on `@bowdoin/storage/s3` instead of deep paths.

import type { Buffer } from 'node:buffer';

export type GetObjectBufferResult = {
  buffer: Buffer;
  contentType?: string;
};

export async function getObjectBuffer(_bucket: string, _key: string): Promise<GetObjectBufferResult> {
  throw new Error('getObjectBuffer is not implemented yet in @bowdoin/storage/s3');
}

export async function putObject(
  _bucket: string,
  _key: string,
  _body: Buffer,
  _contentType: string,
  _cacheControl?: string,
): Promise<void> {
  throw new Error('putObject is not implemented yet in @bowdoin/storage/s3');
}
