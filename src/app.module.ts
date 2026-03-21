import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AuthModule } from "./auth/auth.module";
import { GitHubModule } from "./github/github.module";
import { OrchestratorModule } from "./orchestrator/orchestrator.module";
import { WebhookModule } from "./webhooks/webhook.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    GitHubModule,
    AuthModule,
    OrchestratorModule,
    WebhookModule,
  ],
})
export class AppModule {}
