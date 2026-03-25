import { Module, Global } from "@nestjs/common";
import { GitHubService } from "./github.service";

@Global()
@Module({
  providers: [GitHubService],
  exports: [GitHubService],
})
export class GitHubModule {}
