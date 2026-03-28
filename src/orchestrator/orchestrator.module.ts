import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bull";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { RedisModule } from "@nestjs-modules/ioredis";
import { AgentController } from "./agent.controller";
import { OrchestratorService } from "./orchestrator.service";
import { AgentJobProcessor } from "./agent-job.processor";

@Module({
  imports: [
    // Redis for session state
    RedisModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: "single",
        url: config.getOrThrow<string>("REDIS_URL"),
      }),
    }),
    // BullMQ queue backed by the same Redis
    BullModule.registerQueueAsync({
      name: "agent-jobs",
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        redis: config.getOrThrow<string>("REDIS_URL"),
      }),
    }),
  ],
  controllers: [AgentController],
  providers: [OrchestratorService, AgentJobProcessor, AgentController],
})
export class OrchestratorModule {}
