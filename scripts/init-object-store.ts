import "dotenv/config";
import { CreateBucketCommand, HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";

async function main(): Promise<void> {
  const endpoint = process.env.S3_ENDPOINT;
  if (!endpoint || !["localhost", "127.0.0.1", "minio"].includes(new URL(endpoint).hostname))
    throw new Error("This initializer is for local MinIO. Create production buckets in your storage provider console.");
  const bucket = process.env.S3_BUCKET;
  if (!bucket || !process.env.S3_ACCESS_KEY_ID || !process.env.S3_SECRET_ACCESS_KEY)
    throw new Error("Configure S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY first.");
  const client = new S3Client({
    endpoint,
    region: process.env.S3_REGION ?? "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY },
  });
  try {
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 404) throw error;
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
    }
    console.log("Local object-storage bucket is ready. No public access policy was added.");
  } finally { client.destroy(); }
}
void main().catch(() => {
  console.error("Local object-storage initialization failed. Check MinIO health and the S3 environment settings.");
  process.exitCode = 1;
});
