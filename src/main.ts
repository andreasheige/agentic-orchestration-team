import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { Logger } from "@nestjs/common";
import { json } from "express";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const port = process.env.PORT || 3000;

  app.use(json({ limit: "10mb" }));

  app.enableCors({
    origin: process.env.CORS_ORIGIN || "*",
    credentials: true,
  });

  await app.listen(port);
  Logger.log(`Agent Platform API running on port ${port}`, "Bootstrap");
}
bootstrap();
