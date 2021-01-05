//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

import { ReposAppRequest } from '../../transitional';
import { Repository } from '../../business/repository';
import { IndividualContext } from '../../user';
import { GitHubCollaboratorPermissionLevel } from '../../business/repositoryPermission';

const repoPermissionsCacheKeyName = 'repoPermissions';
const requestScopedRepositoryKeyName = 'repository';

export interface IContextualRepositoryPermissions {
  allowAdministration: boolean;
  admin: boolean;
  write: boolean;
  read: boolean;
  sudo: boolean;
  isLinked: boolean;
}

export function getContextualRepositoryPermissions(req: ReposAppRequest) {
  if (!req[repoPermissionsCacheKeyName]) {
    throw new Error('No permissions available');
  }
  return req[repoPermissionsCacheKeyName] as IContextualRepositoryPermissions;
}

export function setContextualRepository(req: ReposAppRequest, repository: Repository) {
  req[requestScopedRepositoryKeyName] = repository;
}

export function getContextualRepository(req: ReposAppRequest) {
  return req[requestScopedRepositoryKeyName] as Repository;
}

export async function AddRepositoryPermissionsToRequest(req: ReposAppRequest, res, next) {
  if (req[repoPermissionsCacheKeyName]) {
    return next();
  }
  const activeContext = (req.individualContext || req.apiContext) as IndividualContext;
  const repoPermissions: IContextualRepositoryPermissions = {
    isLinked: false,
    allowAdministration: false,
    admin: false,
    sudo: false,
    write: false,
    read: false,
  };
  req[repoPermissionsCacheKeyName] = repoPermissions;
  if (!activeContext.link) {
    return next();
  }
  repoPermissions.isLinked = true;
  const login = activeContext.getGitHubIdentity().username;
  // const idAsString = req.individualContext.getGitHubIdentity().id;
  // const id = idAsString ? parseInt(idAsString, 10) : null;
  const organization = req.organization;
  const repository = req[requestScopedRepositoryKeyName] as Repository;
  const isSudoer = await organization.isSudoer(login);
  const isPortalSudoer = await activeContext.isPortalAdministrator();
  // Indicate that the user is has sudo rights
  if (isSudoer === true || isPortalSudoer === true) {
    repoPermissions.sudo = true;
  }
  try {
    const collaborator = await repository.getCollaborator(login);
    if (collaborator) {
      if (collaborator.permission === GitHubCollaboratorPermissionLevel.Admin) {
        repoPermissions.admin = repoPermissions.read = repoPermissions.write = true;
      } else if (collaborator.permission === GitHubCollaboratorPermissionLevel.Write) {
        repoPermissions.read = repoPermissions.write = true;
      } else if (collaborator.permission === GitHubCollaboratorPermissionLevel.Read) {
        repoPermissions.read = true;
      }
    }
  } catch (getCollaboratorPermissionError) {
    console.dir(getCollaboratorPermissionError);
  }
  // Make a permission decision
  if (repoPermissions.admin || repoPermissions.sudo) {
    repoPermissions.allowAdministration = true;
  }
  return next();
};
