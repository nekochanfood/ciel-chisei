import { defineConfig } from "prisma/config";

export default defineConfig({
	schema: "prisma/schema.prisma",
	migrations: { path: "prisma/migrations" },
	// Generation and validation do not connect. Runtime DB commands set this
	// from config.yaml through scripts/prisma.mjs.
	datasource: {
		url:
			process.env.DATABASE_URL ??
			"postgresql://unused:unused@127.0.0.1:5432/unused",
	},
});
