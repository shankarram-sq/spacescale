import {
  deploymentConfigurationFromEnvironment,
  parseDeploymentEnvironment,
  writeGeneratedWranglerConfig,
} from "./deployment-config.ts";
import { loadLocalEnv } from "./env.ts";
import { ensureLocalDevelopmentSecrets } from "./local-development-secrets.ts";

function requestedEnvironment(args: string[]): string | undefined {
  const index = args.indexOf("--env");
  if (index < 0 || args.length !== 2) return undefined;
  return args[index + 1];
}

try {
  const environment = parseDeploymentEnvironment(requestedEnvironment(process.argv.slice(2)));
  const localSecrets = environment === "development" ? ensureLocalDevelopmentSecrets() : undefined;
  loadLocalEnv(`.env.${environment}`);
  loadLocalEnv();
  const configuration = deploymentConfigurationFromEnvironment(environment, process.env);
  const configPath = writeGeneratedWranglerConfig(configuration);
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      environment,
      configPath,
      ...(localSecrets
        ? {
            localSecrets: {
              created: localSecrets.created,
              path: localSecrets.path,
            },
          }
        : {}),
    })}\n`,
  );
} catch (error) {
  const message = error instanceof Error ? error.message : "Deployment configuration failed.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
