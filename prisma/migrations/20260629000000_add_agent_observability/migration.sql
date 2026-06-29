-- CareCue 4.0 约束式事件循环可观测性（设计文档 2.8）

-- agent_traces：每次工具/LLM 调用、Guard 拦截一行
CREATE TABLE "agent_traces" (
    "id" TEXT NOT NULL,
    "case_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "duration_ms" INTEGER,
    "data" JSONB,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_traces_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "agent_traces_case_id_ts_idx" ON "agent_traces"("case_id", "ts");

-- agent_workspaces：每个会话一行，snapshot 存每轮工作区快照
CREATE TABLE "agent_workspaces" (
    "id" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "rounds" INTEGER NOT NULL DEFAULT 0,
    "risk_level" TEXT NOT NULL DEFAULT 'R0',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_workspaces_pkey" PRIMARY KEY ("id")
);
