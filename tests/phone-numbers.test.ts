import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";
import twilio from "twilio";
import { env } from "../lib/env";
import { createTestAdminApp } from "./admin-helper";
import { createPublicApp } from "../server/http/routes";
import {
  phoneFixture,
  phoneCredentials,
  existingPhone,
  buyPhone,
  purchaseBody,
} from "./phone-number-fixture";
import {
  PhoneNumberApiRepository,
  AssistantApiRepository,
} from "../server/api/v1/repositories/resources";
import { PhoneNumberService } from "../server/api/v1/services/phone-numbers";
import { numberPurchaseSchema } from "../lib/phone-numbers";
import { MongoTwilioCredentialStore } from "../server/storage/credentials";

test(
  "phone workflow uses Twilio SDK, durable isolated storage, and signed inbound callbacks",
  { skip: !process.env.TEST_MONGODB_URI },
  async (t) => {
    const client = await new MongoClient(
      process.env.TEST_MONGODB_URI!,
    ).connect();
    const db = client.db(`phones_${randomUUID().replaceAll("-", "")}`),
      otherDb = client.db(`phones_other_${randomUUID().replaceAll("-", "")}`);
    const previous = { ...env };
    Object.assign(env, {
      TWILIO_ACCOUNT_SID: "",
      TWILIO_AUTH_TOKEN: "",
      PUBLIC_BASE_URL: "https://calls.example/workspaces/owner-one",
      WORKSPACE_USER_ID: "owner-one",
      OPENAI_API_KEY: "test",
      DEEPGRAM_API_KEY: "test",
      ELEVENLABS_API_KEY: "test",
      STREAM_SECRET: "test-only-secret-long-enough-to-sign-streams",
    });
    t.after(async () => {
      Object.assign(env, previous);
      await db.dropDatabase();
      await otherDb.dropDatabase();
      await client.close();
    });
    const f = await phoneFixture(db, "owner-one", env.PUBLIC_BASE_URL);
    const g = await phoneFixture(
      otherDb,
      "owner-two",
      "https://calls.example/workspaces/owner-two",
    );
    const admin = createTestAdminApp(f.deps).listen(0, "127.0.0.1"),
      publicServer = createPublicApp(f.deps).listen(0, "127.0.0.1");
    await Promise.all(
      [admin, publicServer].map(
        (s) => new Promise<void>((r) => s.once("listening", r)),
      ),
    );
    t.after(() => {
      admin.closeAllConnections();
      admin.close();
      publicServer.closeAllConnections();
      publicServer.close();
    });
    const url = `http://127.0.0.1:${(admin.address() as { port: number }).port}`;
    const publicUrl = `http://127.0.0.1:${(publicServer.address() as { port: number }).port}`;
    const api = (path: string, method = "GET", body?: unknown) =>
      fetch(url + "/api" + path, {
        method,
        headers: { "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });

    await t.test(
      "connect verifies credentials, persists encrypted secrets and all number details",
      async () => {
        assert.equal((await api("/numbers")).status, 503);
        const result = await api(
          "/integrations/twilio",
          "PUT",
          phoneCredentials,
        );
        const text = await result.text();
        assert.equal(result.status, 200, text);
        assert.ok(!text.includes(phoneCredentials.authToken));
        assert.equal(JSON.parse(text).numbers.length, 1);
        assert.ok(
          !JSON.stringify(
            await db.collection("providerCredentials").find().toArray(),
          ).includes(phoneCredentials.authToken),
        );
        assert.equal(g.settings.status().configured, false);
        assert.equal(
          await otherDb.collection("phone_numbers").countDocuments(),
          0,
        );
        const record = await db
          .collection("phone_numbers")
          .findOne({ orgId: "owner-one" });
        assert.equal(record?.twilioAccountSid, phoneCredentials.accountSid);
        assert.equal(record?.configuration.capabilities.voice, true);
        const wrongKey = new MongoTwilioCredentialStore(db, "f".repeat(64));
        await assert.rejects(() => wrongKey.initialize(), /Cannot decrypt/);
        const bad = await api("/integrations/twilio", "PUT", {
          ...phoneCredentials,
          authToken: "9".repeat(32),
        });
        assert.equal(bad.status, 422);
        assert.ok(!(await bad.text()).includes("9".repeat(32)));
      },
    );
    await t.test(
      "search quotes prices; purchase is persisted and repeated requests do not buy twice",
      async () => {
        const result = await api("/numbers/available?country=US&type=local");
        assert.equal(result.status, 200);
        const search = await result.json();
        assert.equal(search.monthlyPrice, "1.15");
        assert.equal(search.numbers[0].phoneNumber, buyPhone);
        assert.equal(
          (
            await api("/numbers/purchase", "POST", {
              ...purchaseBody,
              monthlyPrice: "0.01",
            })
          ).status,
          409,
        );
        assert.equal(
          (
            await api("/numbers/purchase", "POST", {
              ...purchaseBody,
              confirmPurchase: false,
            })
          ).status,
          400,
        );
        const purchase = await api("/numbers/purchase", "POST", purchaseBody);
        assert.equal(purchase.status, 201, await purchase.clone().text());
        assert.equal((await purchase.json()).agentId, null);
        assert.equal(
          (await api("/numbers/purchase", "POST", purchaseBody)).status,
          201,
        );
        assert.equal(f.fake.purchases, 1);
        assert.equal((await api("/numbers").then((r) => r.json())).length, 2);
      },
    );
    await t.test(
      "assignment clears overriding TwiML/SIP routes and rejects foreign IDs",
      async () => {
        const path = `/numbers/${existingPhone.sid}/assign`;
        assert.equal(
          (await api(path, "POST", { agentId: g.assistant.id })).status,
          404,
        );
        assert.equal(
          (
            await api(`/numbers/PN${"f".repeat(32)}/assign`, "POST", {
              agentId: f.assistant.id,
            })
          ).status,
          404,
        );
        assert.equal(f.fake.updates.length, 0);
        const response = await api(path, "POST", { agentId: f.assistant.id });
        assert.equal(response.status, 200, await response.clone().text());
        assert.equal((await response.json()).routingStatus, "ready");
        const update = f.fake.updates.at(-1)!;
        assert.equal(
          update.VoiceUrl,
          env.PUBLIC_BASE_URL + "/twilio/voice/inbound",
        );
        assert.equal(update.VoiceApplicationSid, "");
        assert.equal(update.TrunkSid, "");
        assert.equal(update.VoiceFallbackUrl, "");
        assert.equal(update.VoiceMethod, "POST");
        assert.equal(
          await g.management.inboundAssistant(existingPhone.phone_number),
          undefined,
        );
      },
    );
    await t.test(
      "valid signed inbound call selects the assigned assistant; invalid signatures/accounts fail",
      async () => {
        const body = {
          AccountSid: phoneCredentials.accountSid,
          CallSid: "CA" + "5".repeat(32),
          To: existingPhone.phone_number,
          From: "+14155550199",
        };
        const send = (fields: typeof body, signature: string) =>
          fetch(publicUrl + "/twilio/voice/inbound", {
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              "x-twilio-signature": signature,
            },
            body: new URLSearchParams(fields),
          });
        assert.equal((await send(body, "invalid")).status, 403);
        const foreign = { ...body, AccountSid: "AC" + "9".repeat(32) };
        assert.equal(
          (
            await send(
              foreign,
              twilio.getExpectedTwilioSignature(
                phoneCredentials.authToken,
                f.management.voiceUrl,
                foreign,
              ),
            )
          ).status,
          403,
        );
        const response = await send(
          body,
          twilio.getExpectedTwilioSignature(
            phoneCredentials.authToken,
            f.management.voiceUrl,
            body,
          ),
        );
        const xml = await response.text();
        assert.equal(response.status, 200, xml);
        assert.match(
          xml,
          /wss:\/\/calls.example\/workspaces\/owner-one\/media/,
        );
        assert.ok(xml.includes(f.assistant.id));
        assert.equal(
          f.deps.registry.get(body.CallSid)?.agentId,
          f.assistant.id,
        );
        f.deps.registry.update(body.CallSid, "completed");
      },
    );
    await t.test(
      "renaming, unassigning, public API reassignment and route drift repair share persisted configuration",
      async () => {
        assert.equal(
          (
            await api(`/numbers/${existingPhone.sid}`, "PATCH", {
              label: "Sales",
            })
          ).status,
          200,
        );
        assert.equal(
          (
            await api(`/numbers/${existingPhone.sid}/assign`, "POST", {
              agentId: null,
            })
          ).status,
          200,
        );
        assert.equal(
          await f.management.inboundAssistant(existingPhone.phone_number),
          undefined,
        );
        const numbers = new PhoneNumberApiRepository(db, "owner-one"),
          assistants = new AssistantApiRepository(db, "owner-one");
        const record = (
          await numbers.byNumbers([existingPhone.phone_number])
        ).get(existingPhone.phone_number)!;
        const service = new PhoneNumberService({
          numbers,
          assistants,
          telephony: f.telephony,
          accountSid: () => f.settings.current().accountSid,
          management: f.management,
        });
        f.fake.numbers.get(existingPhone.sid)!.voice_url =
          "https://stale.example";
        assert.equal(
          (await service.update(record.id, { assistantId: f.assistant.id }))
            .assistantId,
          f.assistant.id,
        );
        assert.equal(
          f.fake.numbers.get(existingPhone.sid)!.voice_url,
          f.management.voiceUrl,
        );
        f.fake.numbers.get(existingPhone.sid)!.voice_method = "GET";
        assert.equal(
          (await f.management.list()).find((n) => n.sid === existingPhone.sid)
            ?.routingStatus,
          "needs-update",
        );
        f.fake.ignoreRouting = true;
        assert.equal(
          (
            await api(`/numbers/${existingPhone.sid}/assign`, "POST", {
              agentId: null,
            })
          ).status,
          502,
        );
        assert.equal(
          (await f.management.inboundAssistant(existingPhone.phone_number))?.id,
          f.assistant.id,
        );
        f.fake.ignoreRouting = false;
        const otherNumbers = new PhoneNumberApiRepository(db, "owner-two");
        assert.equal(await otherNumbers.get(record.id), undefined);
        assert.equal((await otherNumbers.list({}, 100)).length, 0);
      },
    );
    await t.test(
      "credential replacement excludes concurrent number operations",
      async () => {
        await f.management.exclusive(async () => {
          assert.equal(
            (await api("/integrations/twilio", "PUT", phoneCredentials)).status,
            409,
          );
          assert.equal(
            (await api("/numbers/purchase", "POST", purchaseBody)).status,
            409,
          );
        });
      },
    );
    await t.test(
      "unconfirmed purchase is reconciled without a second charge, or blocked if still unknown",
      async () => {
        f.fake.numbers.delete("PN" + "4".repeat(32));
        await f.repository.cancelPurchase(
          phoneCredentials.accountSid,
          buyPhone,
        );
        f.fake.failPurchase = "after";
        assert.equal(
          (await api("/numbers/purchase", "POST", purchaseBody)).status,
          502,
        );
        const purchases = f.fake.purchases;
        assert.equal(
          (await api("/numbers/purchase", "POST", purchaseBody)).status,
          201,
        );
        assert.equal(f.fake.purchases, purchases);
        f.fake.numbers.delete("PN" + "4".repeat(32));
        await f.repository.cancelPurchase(
          phoneCredentials.accountSid,
          buyPhone,
        );
        f.fake.failPurchase = "before";
        assert.equal(
          (await api("/numbers/purchase", "POST", purchaseBody)).status,
          502,
        );
        assert.equal(
          (await api("/numbers/purchase", "POST", purchaseBody)).status,
          409,
        );
        f.fake.failPurchase = null;
        assert.equal(f.fake.purchases, purchases + 1);
      },
    );
    await t.test(
      "legacy owned assignments are retained without claiming unowned records",
      async () => {
        await db.collection("phone_numbers").updateOne(
          { orgId: "owner-one", number: existingPhone.phone_number },
          {
            $unset: { twilioAccountSid: "", available: "" },
            $set: { assistantId: f.assistant.id },
          },
        );
        await db
          .collection("phone_numbers")
          .insertOne({ number: "+14155550999", assistantId: g.assistant.id });
        assert.equal(
          (await f.management.inboundAssistant(existingPhone.phone_number))?.id,
          f.assistant.id,
        );
        await f.management.list();
        const legacy = await db
          .collection("phone_numbers")
          .findOne({ number: "+14155550999" });
        assert.equal(legacy?.orgId, undefined);
        assert.equal(legacy?.assistantId, g.assistant.id);
      },
    );
    await t.test(
      "account switches retire old number assignments and restart retains new configuration",
      async () => {
        const credentials = {
          accountSid: "AC" + "6".repeat(32),
          authToken: "7".repeat(32),
        };
        f.fake.credentials = credentials;
        f.fake.numbers.clear();
        const connect = await api("/integrations/twilio", "PUT", credentials);
        assert.equal(connect.status, 200, await connect.clone().text());
        assert.equal((await connect.json()).numbers.length, 0);
        assert.equal(
          await f.management.inboundAssistant(existingPhone.phone_number),
          undefined,
        );
        assert.equal(
          await f.deps.store.numberForAgent(f.assistant.id),
          undefined,
        );
        assert.equal(
          (await new PhoneNumberApiRepository(db, "owner-one").list({}, 100))
            .length,
          0,
        );
        const restarted = await phoneFixture(
          db,
          "owner-one",
          env.PUBLIC_BASE_URL,
          f.fake,
        );
        assert.equal(
          restarted.settings.current().accountSid,
          credentials.accountSid,
        );
        assert.equal((await restarted.management.list()).length, 0);
        assert.throws(() =>
          numberPurchaseSchema.parse({ ...purchaseBody, country: "USA" }),
        );
      },
    );
  },
);
