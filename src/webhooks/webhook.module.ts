import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bull";
import { GitHubWebhookController } from "./github-webhook.controller";

@Module({
  imports: [BullModule.registerQueue({ name: "agent-jobs" })],
  controllers: [GitHubWebhookController],
})
export class WebhookModule {}
