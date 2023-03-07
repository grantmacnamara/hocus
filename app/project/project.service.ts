import type { Prisma, Project } from "@prisma/client";
import { StatusCodes } from "http-status-codes";
import { match } from "ts-pattern";
import { HttpError } from "~/http-error.server";
import { waitForPromises } from "~/utils.shared";

import { ENV_VAR_NAME_REGEX, UpdateEnvVarsTarget } from "./env-form.shared";

export interface UpdateEnvVarsArgs {
  userId: bigint;
  projectExternalId: string;
  delete: string[];
  create: { name: string; value: string }[];
  update: { name?: string; value?: string; externalId: string }[];
  target: UpdateEnvVarsTarget;
}

export class ProjectService {
  async createProject(
    db: Prisma.TransactionClient,
    args: {
      gitRepositoryId: bigint;
      rootDirectoryPath: string;
      name: string;
    },
  ): Promise<Project> {
    const environmentVariableSet = await db.environmentVariableSet.create({ data: {} });
    return await db.project.create({
      data: {
        gitRepositoryId: args.gitRepositoryId,
        rootDirectoryPath: args.rootDirectoryPath,
        environmentVariableSetId: environmentVariableSet.id,
        name: args.name,
      },
    });
  }

  async updateEnvironmentVariables(
    db: Prisma.TransactionClient,
    args: UpdateEnvVarsArgs,
  ): Promise<void> {
    const project = await db.project.findUnique({
      where: { externalId: args.projectExternalId },
      include: {
        environmentVariableSet: {
          include: { environmentVariables: true },
        },
      },
    });
    if (project == null) {
      throw new HttpError(StatusCodes.NOT_FOUND, "Project not found");
    }
    const envVarSet = await match(args.target)
      .with(UpdateEnvVarsTarget.USER, async () => {
        const userSet = await db.userProjectEnvironmentVariableSet.upsert({
          // eslint-disable-next-line camelcase
          where: { userId_projectId: { userId: args.userId, projectId: project.id } },
          create: {
            user: { connect: { id: args.userId } },
            project: { connect: { id: project.id } },
            environmentSet: { create: {} },
          },
          update: {},
          include: {
            environmentSet: {
              include: { environmentVariables: true },
            },
          },
        });
        return userSet.environmentSet;
      })
      .with(UpdateEnvVarsTarget.PROJECT, async () => {
        return project.environmentVariableSet;
      })
      .exhaustive();
    const vars = new Map(envVarSet.environmentVariables.map((v) => [v.externalId, v] as const));
    const getVar = (externalId: string) => {
      const v = vars.get(externalId);
      if (v == null) {
        throw new HttpError(StatusCodes.BAD_REQUEST, `Variable with id "${externalId}" not found`);
      }
      return v;
    };
    const varsToDelete = args.delete.map((externalId) => getVar(externalId).id);
    const varsToUpdateName = args.update
      .map((v) => (v.name != null ? { id: getVar(v.externalId).id, name: v.name } : null))
      .filter((v): v is { id: bigint; name: string } => v != null);
    const varsToUpdateValue = args.update
      .map((v) => (v.value != null ? { id: getVar(v.externalId).id, value: v.value } : null))
      .filter((v): v is { id: bigint; value: string } => v != null);
    const varsToCreate = args.create;

    for (const v of [...varsToUpdateName, ...varsToCreate]) {
      if (!ENV_VAR_NAME_REGEX.test(v.name)) {
        throw new HttpError(
          StatusCodes.BAD_REQUEST,
          `Invalid variable name "${v.name}" (must match "${ENV_VAR_NAME_REGEX}")`,
        );
      }
    }

    await db.environmentVariable.deleteMany({
      where: { id: { in: varsToDelete } },
    });
    const updateNamePromises = varsToUpdateName.map((v) =>
      db.environmentVariable.update({ where: { id: v.id }, data: { name: v.name } }),
    );
    const updateValuePromises = varsToUpdateValue.map((v) =>
      db.environmentVariable.update({ where: { id: v.id }, data: { value: v.value } }),
    );
    const createPromises = varsToCreate.map((v) =>
      db.environmentVariable.create({
        data: {
          name: v.name,
          value: v.value,
          environmentVariableSet: { connect: { id: envVarSet.id } },
        },
      }),
    );
    await waitForPromises([...updateNamePromises, ...updateValuePromises, ...createPromises]);
  }
}
