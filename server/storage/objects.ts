import { Readable } from "node:stream";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface ObjectStoreOptions {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
}
export interface StoredObject {
  key: string;
  bucket: string;
  contentType: string;
  size: number;
  createdAt: string;
}
const PART_BYTES = 5 * 1024 * 1024;

/** S3-compatible private object storage. Buckets must be provisioned separately. */
export class ObjectStore {
  private readonly client: S3Client;
  constructor(private readonly options: ObjectStoreOptions, client?: S3Client) {
    this.client = client ?? new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      forcePathStyle: options.forcePathStyle ?? false,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
      // Compatible with both R2 and local S3 services.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }
  async check(): Promise<void> {
    if (!this.options.accessKeyId || !this.options.secretAccessKey)
      throw new Error("Set S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY to your object storage API credentials.");
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.options.bucket }));
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      const hint = status === 401 || status === 403
        ? "Access denied. Check the S3 access-key pair, bucket-scoped Object Read & Write permission, and matching R2 account endpoint."
        : status === 404
          ? "Bucket not found. S3_BUCKET must be the exact existing bucket name; S3_ENDPOINT must be the S3 API endpoint without a bucket path."
          : "Check S3_ENDPOINT (the S3 API endpoint, not a public bucket URL), S3_BUCKET, region, and API credentials.";
      const failure = new Error(`Object storage bucket check failed (HTTP ${status ?? "unavailable"}). ${hint}`, { cause: error });
      Object.assign(failure, { $metadata: { httpStatusCode: status } });
      throw failure;
    }
  }
  async put(key: string, body: string | Buffer | Uint8Array, contentType: string): Promise<StoredObject> {
    this.validateKey(key);
    const data = typeof body === "string" ? Buffer.from(body) : body;
    await this.client.send(new PutObjectCommand({
      Bucket: this.options.bucket, Key: key, Body: data,
      ContentType: contentType, ContentLength: data.byteLength,
    }));
    return this.metadata(key, contentType, data.byteLength);
  }
  /** Multipart uploads keep memory bounded when exporting long calls or recordings. */
  async putStream(key: string, input: AsyncIterable<Uint8Array | string>, contentType: string): Promise<StoredObject> {
    this.validateKey(key);
    const created = await this.client.send(new CreateMultipartUploadCommand({
      Bucket: this.options.bucket, Key: key, ContentType: contentType,
    }));
    if (!created.UploadId) throw new Error("Object storage did not return an upload ID.");
    const UploadId = created.UploadId;
    const parts: { ETag: string; PartNumber: number }[] = [];
    let pending: Buffer[] = [], pendingBytes = 0, size = 0;
    const uploadPart = async (body: Buffer) => {
      if (parts.length >= 10_000) throw new Error("Artifact exceeds the maximum multipart upload size.");
      const PartNumber = parts.length + 1;
      const result = await this.client.send(new UploadPartCommand({
        Bucket: this.options.bucket, Key: key, UploadId, PartNumber,
        Body: body, ContentLength: body.length,
      }));
      if (!result.ETag) throw new Error("Object storage did not return a part ETag.");
      parts.push({ ETag: result.ETag, PartNumber });
      size += body.length;
    };
    try {
      for await (const chunk of input) {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
        let offset = 0;
        while (offset < bytes.length) {
          const take = Math.min(PART_BYTES - pendingBytes, bytes.length - offset);
          pending.push(bytes.subarray(offset, offset + take));
          pendingBytes += take;
          offset += take;
          if (pendingBytes === PART_BYTES) {
            await uploadPart(Buffer.concat(pending, pendingBytes));
            pending = [];
            pendingBytes = 0;
          }
        }
      }
      if (pendingBytes || !parts.length) await uploadPart(Buffer.concat(pending, pendingBytes));
      await this.client.send(new CompleteMultipartUploadCommand({
        Bucket: this.options.bucket, Key: key, UploadId,
        MultipartUpload: { Parts: parts },
      }));
      return this.metadata(key, contentType, size);
    } catch (error) {
      await this.client.send(new AbortMultipartUploadCommand({
        Bucket: this.options.bucket, Key: key, UploadId,
      })).catch(() => undefined);
      throw error;
    }
  }
  async signedUrl(key: string, expiresIn = 300): Promise<string> {
    this.validateKey(key);
    if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > 900)
      throw new Error("Download URLs must expire within 15 minutes.");
    return getSignedUrl(this.client, new GetObjectCommand({
      Bucket: this.options.bucket, Key: key,
      ResponseContentDisposition: "attachment",
    }), { expiresIn });
  }
  async read(key: string): Promise<Readable> {
    this.validateKey(key);
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.options.bucket, Key: key }));
    if (!response.Body || !(response.Body instanceof Readable))
      throw new Error("Object storage returned an invalid response body.");
    return response.Body;
  }
  close(): void { this.client.destroy(); }
  private metadata(key: string, contentType: string, size: number): StoredObject {
    return { key, bucket: this.options.bucket, contentType, size, createdAt: new Date().toISOString() };
  }
  private validateKey(key: string): void {
    if (!key || key.length > 1024 || key.startsWith("/") || key.split("/").includes(".."))
      throw new Error("Invalid object key.");
  }
}
