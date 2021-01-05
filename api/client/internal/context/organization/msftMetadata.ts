//
// Copyright (c) Microsoft. All Rights Reseved.
//

import express from 'express';
import asyncHandler from 'express-async-handler';
import { Operations } from '../../../../../business/operations';
import { Repository } from '../../../../../business/repository';
import { IMail } from '../../../../../lib/mailProvider';
import { MicrosoftMetadata, MicrosoftMetadataField } from '../../../../../microsoft/entities/msftMetadata';

import { AddRepositoryPermissionsToRequest, getContextualRepository, getContextualRepositoryPermissions, setContextualRepository } from '../../../../../middleware/github/repoPermissions';
import { jsonError } from '../../../../../middleware/jsonError';
import { IProviders, ReposAppRequest } from '../../../../../transitional';
import { IndividualContext } from '../../../../../user';

const router = express.Router();

enum PatchGroup {
  GitHubEnterpriseMigration = 'ghpi',
  AssetClassification = 'classification',
  Maintainer = 'maintainer',
  ServiceTree = 'servicetree',
}

const patchGroups = [
  PatchGroup.GitHubEnterpriseMigration,
  PatchGroup.Maintainer,
  PatchGroup.AssetClassification,
  PatchGroup.ServiceTree,
];

const fieldGroups = {
  [PatchGroup.GitHubEnterpriseMigration]: [
    MicrosoftMetadataField.enterpriseOptIn,
    MicrosoftMetadataField.enterpriseOptInDetails,
    MicrosoftMetadataField.enterpriseOptOutApps,
    MicrosoftMetadataField.enterpriseOptOutAppsDetails,
    MicrosoftMetadataField.enterpriseOptOutCollaboration,
    MicrosoftMetadataField.enterpriseOptOutCollaborationDetails,
    MicrosoftMetadataField.enterpriseOptOutOther,
    MicrosoftMetadataField.enterpriseOptOutOtherDetails,
    MicrosoftMetadataField.enterpriseOptOutStaging,
    MicrosoftMetadataField.enterpriseOptOutStagingDetails,
  ],
  [PatchGroup.AssetClassification]: [
    MicrosoftMetadataField.classification,
  ],
  [PatchGroup.Maintainer]: [
    MicrosoftMetadataField.maintainerCorporateIds,
    MicrosoftMetadataField.maintainerSecurityGroup,
  ],
  [PatchGroup.ServiceTree]: [
    MicrosoftMetadataField.serviceTreeExempt,
    MicrosoftMetadataField.serviceTreeExemptDetails,
    MicrosoftMetadataField.serviceTreeNode,
  ],
}

const patchableFields = [
  ...fieldGroups[PatchGroup.GitHubEnterpriseMigration],
  ...fieldGroups[PatchGroup.AssetClassification],
  ...fieldGroups[PatchGroup.Maintainer],
  ...fieldGroups[PatchGroup.ServiceTree],
];

const mapPatchGroupToUpdateDateFields = {
  [PatchGroup.GitHubEnterpriseMigration]: [
    MicrosoftMetadataField.enterpriseUpdated,
  ],
  [PatchGroup.AssetClassification]: [
    MicrosoftMetadataField.classificationUpdated,
  ],
  [PatchGroup.Maintainer]: [
    MicrosoftMetadataField.maintainerUpdated,
  ],
  [PatchGroup.ServiceTree]: [
    MicrosoftMetadataField.serviceTreeUpdated,
  ],
};

const mapPatchGroupToUpdateUserFields = {
  [PatchGroup.GitHubEnterpriseMigration]: [
    MicrosoftMetadataField.enterpriseUpdatedBy,
  ],
  [PatchGroup.AssetClassification]: [
    MicrosoftMetadataField.classificationUpdatedBy,
  ],
  [PatchGroup.Maintainer]: [
    MicrosoftMetadataField.maintainerUpdatedBy,
  ],
  [PatchGroup.ServiceTree]: [
    MicrosoftMetadataField.serviceTreeUpdatedBy,
  ],
};

const featureFlagGhpiMigration = 'ghpimigrationphase1';

async function evaluateWhetherEligible(repository: Repository): Promise<boolean> {
  const organization = repository.organization;
  let isEligible = false;
  if (repository.private && organization.hasDynamicSettings && organization.getDynamicSettings().hasFeature(featureFlagGhpiMigration)) {
    isEligible = true;
  }
  return isEligible;
}

router.patch('/', AddRepositoryPermissionsToRequest, asyncHandler(async (req: ReposAppRequest, res, next) => {
  const { microsoftMetadataProvider, operations } = req.app.settings.providers as IProviders;
  const activeContext = (req.individualContext || req.apiContext) as IndividualContext;
  const repository = getContextualRepository(req);
  if (await repository.isDeleted()) {
    return next(jsonError('repo not found', 404));
  }
  const permissions = getContextualRepositoryPermissions(req);
  if (!permissions.allowAdministration) {
    return next(jsonError(`not authorized to administer ${repository.full_name}`, 403));
  }
  const metadata = await microsoftMetadataProvider.getMetadata(String(repository.id));
  if (req.body.resetTemporary) {
    metadata.classification = undefined;
    metadata.classificationUpdated = undefined;
    metadata.classificationUpdatedBy = undefined;
    metadata.enterpriseInformed = undefined;
    metadata.enterpriseOptIn = undefined;
    metadata.enterpriseOptInDetails = undefined;
    metadata.enterpriseOptOutApps = undefined;
    metadata.enterpriseOptOutAppsDetails = undefined;
    metadata.enterpriseOptOutCollaboration = undefined;
    metadata.enterpriseOptOutCollaborationDetails = undefined;;
    metadata.enterpriseOptOutOther = undefined;
    metadata.enterpriseOptOutOtherDetails = undefined;
    metadata.enterpriseOptOutStaging = undefined;
    metadata.enterpriseOptOutStagingDetails = undefined;
    metadata.enterpriseReviewComments = undefined;
    metadata.enterpriseReviewUpdated = undefined;
    metadata.enterpriseReviewUpdatedBy = undefined;
    metadata.enterpriseVisited = undefined;
    metadata.maintainerCorporateIds = undefined;
    metadata.maintainerSecurityGroup = undefined;
    metadata.maintainerUpdated = undefined;
    metadata.maintainerUpdatedBy = undefined;
    metadata.serviceTreeExempt = undefined;
    metadata.serviceTreeExemptDetails = undefined;
    metadata.serviceTreeNode = undefined;
    metadata.serviceTreeUpdated = undefined;
    metadata.serviceTreeUpdatedBy = undefined;
    await microsoftMetadataProvider.replaceMetadata(metadata);
  }
  const changes = req.body as MicrosoftMetadata;
  const updatedGroups = new Set<PatchGroup>();
  // only change certain GHPI-related fields
  let changed = false;
  for (let i = 0; i < patchableFields.length; i++) {
    let thisFieldChanged = false;
    const fieldName = patchableFields[i];
    if (changes[fieldName] !== undefined && metadata[fieldName] !== changes[fieldName]) {
      changed = true;
      thisFieldChanged = true;
      console.log(`field ${fieldName} changed from ${metadata[fieldName]} to ${changes[fieldName]}`);
      metadata[fieldName] = changes[fieldName];
    } else if (changes[fieldName] !== undefined && metadata[fieldName] != changes[fieldName]) {
      // loose compare!
      changed = true;
      thisFieldChanged = true;
      console.log(`field LOOSELY ${fieldName} changed from ${metadata[fieldName]} to ${changes[fieldName]}`);
      metadata[fieldName] = changes[fieldName];
    }
    let patchedGroup: PatchGroup = null;
    patchGroups.forEach(group => {
      const fields = fieldGroups[group];
      if (fields && fields.includes(fieldName)) {
        patchedGroup = group;
      }
    });
    if (thisFieldChanged && !patchedGroup) {
      return next(jsonError('invalid patachable field', 500));
    }
    if (thisFieldChanged) {
      // console.log(`field group ${patchedGroup} touched by field ${fieldName}`);
      updatedGroups.add(patchedGroup);
    }
  }
  if (changed) {
    for (let i = 0; i < patchGroups.length; i++) {
      const group = patchGroups[i];
      if (!updatedGroups.has(group)) {
        continue;
      }
      const dateFields = mapPatchGroupToUpdateDateFields[group];
      const userFields = mapPatchGroupToUpdateUserFields[group];
      dateFields.map((field: string) => {
        metadata[field] = new Date();
        console.log(`${field}: ${metadata[field]}`);
      });
      userFields.map((field: string) => {
        metadata[field] = activeContext.corporateIdentity.id;
        console.log(`${field}: ${metadata[field]}`);
      });
    }
    const patchedGroups = Array.from(updatedGroups.values());
    try {
      await microsoftMetadataProvider.replaceMetadata(metadata);
      res.status(202); // accepted
      nextTickAsyncSendMail(operations, activeContext, repository, patchedGroups, metadata);
      return res.json({
        patchedGroups,
        microsoftMetadata: metadata,
      });
    } catch (error) {
      throw error;
    }
  }
  res.status(200); // no changes
  return res.json({
    microsoftMetadata: metadata,
  });
}));

router.post('/reevaluate', AddRepositoryPermissionsToRequest, asyncHandler(async (req: ReposAppRequest, res, next) => {
  const { microsoftMetadataProvider } = req.app.settings.providers as IProviders;
  const permissions = getContextualRepositoryPermissions(req);
  const repository = getContextualRepository(req);
  await repository.getDetails();
  let updatedVisibility = false;
  let updatedVisited = false;
  let error = undefined;
  try {
    const metadata = await microsoftMetadataProvider.getMetadata(String(repository.id));
    if (metadata) {
      if (metadata.enterpriseEligible !== true && metadata.enterpriseEligible !== false) {
        // Flip the repo to be eligible for migration, if private, or store if public
        metadata.enterpriseEligible = await evaluateWhetherEligible(repository);
        updatedVisibility = true;
      }
      // DESIGN: currently only toggling that an admin visited this repo if it's PRIVATE,
      // since the current focus is on that experience.
      //
      // ONCE the plan for maintainers data and other fields is good for broader use
      // in all open source repos, this logic should be changed.
      // TODO: also toggle visited by admins when the repo is public
      if (metadata.enterpriseEligible === true && permissions.admin && !metadata.enterpriseVisited) {
        metadata.enterpriseVisited = new Date();
        updatedVisited = true;
      }
      await microsoftMetadataProvider.replaceMetadata(metadata);
    }
  } catch (getError) {
    console.log('evaluateMicrosoftMetadata error:');
    console.dir(getError);
    error = getError;
    updatedVisited = false;
    updatedVisibility = false;
  }
  if (updatedVisibility) {
    console.log(`set enterprise visibility data for ${repository.full_name}`);
  }
  if (updatedVisited) {
    console.log(`enterprise admin visit for ${repository.full_name}`);
  }
  return res.json({updatedVisibility, updatedVisited, error});
}));

router.use('*', (req, res, next) => {
  return next(jsonError(`no API or ${req.method} function available for repo Microsoft metadata`, 404));
});

// --- mail goo


function nextTickAsyncSendMail(operations: Operations, context: IndividualContext, repository: Repository, patchedGroups: PatchGroup[], microsoftMetadata: MicrosoftMetadata) {
  const insights = operations.insights;
  process.nextTick(() => {
    sendPatchMailNotification(operations, context, repository, patchedGroups, microsoftMetadata).then(ok => {
      insights?.trackEvent({ name: 'MetadataPatchMailSent', properties: { repoId: microsoftMetadata.repoIdentity } });
    }).catch(error => {
      insights?.trackException({ exception: error });
      insights?.trackEvent({ name: 'MetadataPatchMailSendFailed', properties: { repoId: microsoftMetadata.repoIdentity } });
    });
  });
}

async function sendPatchMailNotification(operations: Operations, context: IndividualContext, repository: Repository, patchedGroups: PatchGroup[], microsoftMetadata: MicrosoftMetadata) {
  const operationsMails = [ operations.getRepositoriesNotificationMailAddress() ];
  const ghi = context.getGitHubIdentity();
  const link = context.link;
  const details = {
    thirdPartyUsername: ghi.username,
    patchedGroups,
    microsoftMetadata,
    repository: repository.asJson(),
    link,
    mailAddress: null,
  };
  if (operationsMails) {
    try {
      const mailToOperations: IMail = {
        to: operationsMails,
        subject: `Metadata patched by ${link.corporateAlias || ghi.username}`,
        content: await operations.emailRender('metadataPatch', {
          reason: (`A user just updated the Microsoft corporate metadata for a repository. As the operations contact for this system, you are receiving this e-mail.
                    This mail was sent to: ${operationsMails.join(', ')}`),
          headline: 'Metadata updated',
          notification: 'information',
          app: `${operations.config.brand.companyName} GitHub`,
          isMailToOperations: true,
          isMailToUser: false,
          details,
        }),
      };
      await operations.sendMail(mailToOperations);
    } catch (mailIssue) {
      console.dir(mailIssue);
    }
  }
}


export default router;
