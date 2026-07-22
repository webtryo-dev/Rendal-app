/* eslint-disable eslint-comments/disable-enable-pair */
/* eslint-disable eslint-comments/no-unlimited-disable */
/* eslint-disable */
import type * as AdminTypes from './admin.types.js';

export type CofounderShopIdQueryVariables = AdminTypes.Exact<{ [key: string]: never; }>;


export type CofounderShopIdQuery = { shop: Pick<AdminTypes.Shop, 'id'> };

export type CofounderSearchProductsQueryVariables = AdminTypes.Exact<{
  query?: AdminTypes.InputMaybe<AdminTypes.Scalars['String']['input']>;
  first: AdminTypes.Scalars['Int']['input'];
}>;


export type CofounderSearchProductsQuery = { products: { nodes: Array<(
      Pick<AdminTypes.Product, 'id' | 'title' | 'handle' | 'status' | 'totalInventory'>
      & { priceRangeV2: { minVariantPrice: Pick<AdminTypes.MoneyV2, 'amount' | 'currencyCode'>, maxVariantPrice: Pick<AdminTypes.MoneyV2, 'amount' | 'currencyCode'> } }
    )> } };

export type CofounderGetProductQueryVariables = AdminTypes.Exact<{
  id: AdminTypes.Scalars['ID']['input'];
}>;


export type CofounderGetProductQuery = { product?: AdminTypes.Maybe<(
    Pick<AdminTypes.Product, 'id' | 'title' | 'handle' | 'status' | 'descriptionHtml' | 'vendor' | 'tags' | 'totalInventory'>
    & { variants: { nodes: Array<Pick<AdminTypes.ProductVariant, 'id' | 'title' | 'price' | 'sku' | 'inventoryQuantity'>> } }
  )> };

export type CofounderGetInventoryLevelsQueryVariables = AdminTypes.Exact<{
  id: AdminTypes.Scalars['ID']['input'];
}>;


export type CofounderGetInventoryLevelsQuery = { product?: AdminTypes.Maybe<(
    Pick<AdminTypes.Product, 'id' | 'title'>
    & { variants: { nodes: Array<(
        Pick<AdminTypes.ProductVariant, 'id' | 'title' | 'sku'>
        & { inventoryItem: (
          Pick<AdminTypes.InventoryItem, 'id' | 'tracked'>
          & { inventoryLevels: { nodes: Array<{ location: Pick<AdminTypes.Location, 'id' | 'name'>, quantities: Array<Pick<AdminTypes.InventoryQuantity, 'name' | 'quantity'>> }> } }
        ) }
      )> } }
  )> };

export type CofounderGetShippingSetupQueryVariables = AdminTypes.Exact<{ [key: string]: never; }>;


export type CofounderGetShippingSetupQuery = { shop: Pick<AdminTypes.Shop, 'name' | 'currencyCode' | 'shipsToCountries'>, deliveryProfiles: { nodes: Array<(
      Pick<AdminTypes.DeliveryProfile, 'id' | 'name' | 'default'>
      & { profileLocationGroups: Array<{ locationGroup: Pick<AdminTypes.DeliveryLocationGroup, 'id'>, locationGroupZones: { nodes: Array<{ zone: (
              Pick<AdminTypes.DeliveryZone, 'id' | 'name'>
              & { countries: Array<(
                Pick<AdminTypes.DeliveryCountry, 'name'>
                & { code: Pick<AdminTypes.DeliveryCountryCodeOrRestOfWorld, 'countryCode' | 'restOfWorld'> }
              )> }
            ), methodDefinitions: { nodes: Array<(
                Pick<AdminTypes.DeliveryMethodDefinition, 'id' | 'name' | 'active'>
                & { rateProvider: (
                  Pick<AdminTypes.DeliveryRateDefinition, 'id'>
                  & { price: Pick<AdminTypes.MoneyV2, 'amount' | 'currencyCode'> }
                ) }
              )> } }> } }> }
    )> } };

export type CofounderDeliveryProfileUpdateMutationVariables = AdminTypes.Exact<{
  id: AdminTypes.Scalars['ID']['input'];
  profile: AdminTypes.DeliveryProfileInput;
}>;


export type CofounderDeliveryProfileUpdateMutation = { deliveryProfileUpdate?: AdminTypes.Maybe<{ profile?: AdminTypes.Maybe<Pick<AdminTypes.DeliveryProfile, 'id' | 'name'>>, userErrors: Array<Pick<AdminTypes.UserError, 'field' | 'message'>> }> };

export type CofounderShopCurrencyQueryVariables = AdminTypes.Exact<{ [key: string]: never; }>;


export type CofounderShopCurrencyQuery = { shop: Pick<AdminTypes.Shop, 'currencyCode'> };

export type CofounderListDiscountsQueryVariables = AdminTypes.Exact<{ [key: string]: never; }>;


export type CofounderListDiscountsQuery = { discountNodes: { nodes: Array<(
      Pick<AdminTypes.DiscountNode, 'id'>
      & { discount: { __typename: 'DiscountAutomaticApp' | 'DiscountAutomaticBxgy' | 'DiscountAutomaticFreeShipping' | 'DiscountCodeApp' | 'DiscountCodeBxgy' | 'DiscountCodeFreeShipping' } | (
        { __typename: 'DiscountAutomaticBasic' }
        & Pick<AdminTypes.DiscountAutomaticBasic, 'title' | 'status' | 'summary'>
      ) | (
        { __typename: 'DiscountCodeBasic' }
        & Pick<AdminTypes.DiscountCodeBasic, 'title' | 'status' | 'summary'>
        & { codes: { nodes: Array<Pick<AdminTypes.DiscountRedeemCode, 'code'>> } }
      ) }
    )> } };

export type CofounderGetShopInfoQueryVariables = AdminTypes.Exact<{ [key: string]: never; }>;


export type CofounderGetShopInfoQuery = { shop: (
    Pick<AdminTypes.Shop, 'name' | 'email' | 'contactEmail' | 'myshopifyDomain' | 'currencyCode' | 'ianaTimezone' | 'weightUnit'>
    & { primaryDomain: Pick<AdminTypes.Domain, 'url' | 'host'>, plan: Pick<AdminTypes.ShopPlan, 'publicDisplayName' | 'partnerDevelopment' | 'shopifyPlus'>, shopPolicies: Array<Pick<AdminTypes.ShopPolicy, 'type' | 'title' | 'url' | 'body'>> }
  ) };

export type CofounderGetShopPoliciesQueryVariables = AdminTypes.Exact<{ [key: string]: never; }>;


export type CofounderGetShopPoliciesQuery = { shop: { shopPolicies: Array<Pick<AdminTypes.ShopPolicy, 'type' | 'body'>> } };

export type CofounderShopPolicyUpdateMutationVariables = AdminTypes.Exact<{
  shopPolicy: AdminTypes.ShopPolicyInput;
}>;


export type CofounderShopPolicyUpdateMutation = { shopPolicyUpdate?: AdminTypes.Maybe<{ shopPolicy?: AdminTypes.Maybe<Pick<AdminTypes.ShopPolicy, 'id' | 'type' | 'url'>>, userErrors: Array<Pick<AdminTypes.ShopPolicyUserError, 'field' | 'message' | 'code'>> }> };

export type CofounderListCustomersQueryVariables = AdminTypes.Exact<{
  first: AdminTypes.Scalars['Int']['input'];
  query?: AdminTypes.InputMaybe<AdminTypes.Scalars['String']['input']>;
  after?: AdminTypes.InputMaybe<AdminTypes.Scalars['String']['input']>;
}>;


export type CofounderListCustomersQuery = { customers: { nodes: Array<(
      Pick<AdminTypes.Customer, 'id' | 'displayName' | 'firstName' | 'lastName' | 'numberOfOrders' | 'createdAt'>
      & { amountSpent: Pick<AdminTypes.MoneyV2, 'amount' | 'currencyCode'>, defaultEmailAddress?: AdminTypes.Maybe<Pick<AdminTypes.CustomerEmailAddress, 'emailAddress'>>, defaultPhoneNumber?: AdminTypes.Maybe<Pick<AdminTypes.CustomerPhoneNumber, 'phoneNumber'>>, defaultAddress?: AdminTypes.Maybe<Pick<AdminTypes.MailingAddress, 'address1' | 'address2' | 'city' | 'province' | 'provinceCode' | 'country' | 'countryCodeV2' | 'zip'>> }
    )>, pageInfo: Pick<AdminTypes.PageInfo, 'hasNextPage' | 'endCursor'> } };

export type CofounderShopifyQlQueryVariables = AdminTypes.Exact<{
  query: AdminTypes.Scalars['String']['input'];
}>;


export type CofounderShopifyQlQuery = { shopifyqlQuery?: AdminTypes.Maybe<(
    Pick<AdminTypes.ShopifyqlQueryResponse, 'parseErrors'>
    & { tableData?: AdminTypes.Maybe<(
      Pick<AdminTypes.ShopifyqlTableData, 'rows'>
      & { columns: Array<Pick<AdminTypes.ShopifyqlTableDataColumn, 'name' | 'dataType' | 'displayName'>> }
    )> }
  )> };

export type CofounderGetDiscountQueryVariables = AdminTypes.Exact<{
  id: AdminTypes.Scalars['ID']['input'];
}>;


export type CofounderGetDiscountQuery = { discountNode?: AdminTypes.Maybe<(
    Pick<AdminTypes.DiscountNode, 'id'>
    & { discount: { __typename: 'DiscountAutomaticApp' | 'DiscountAutomaticFreeShipping' | 'DiscountCodeApp' } | (
      { __typename: 'DiscountAutomaticBasic' }
      & Pick<AdminTypes.DiscountAutomaticBasic, 'title' | 'status'>
    ) | (
      { __typename: 'DiscountAutomaticBxgy' }
      & Pick<AdminTypes.DiscountAutomaticBxgy, 'title' | 'status'>
    ) | (
      { __typename: 'DiscountCodeBasic' }
      & Pick<AdminTypes.DiscountCodeBasic, 'title' | 'status'>
      & { codes: { nodes: Array<Pick<AdminTypes.DiscountRedeemCode, 'code'>> } }
    ) | (
      { __typename: 'DiscountCodeBxgy' }
      & Pick<AdminTypes.DiscountCodeBxgy, 'title' | 'status'>
      & { codes: { nodes: Array<Pick<AdminTypes.DiscountRedeemCode, 'code'>> } }
    ) | (
      { __typename: 'DiscountCodeFreeShipping' }
      & Pick<AdminTypes.DiscountCodeFreeShipping, 'title' | 'status'>
      & { codes: { nodes: Array<Pick<AdminTypes.DiscountRedeemCode, 'code'>> } }
    ) }
  )> };

export type CofounderListThemesQueryVariables = AdminTypes.Exact<{ [key: string]: never; }>;


export type CofounderListThemesQuery = { themes?: AdminTypes.Maybe<{ nodes: Array<Pick<AdminTypes.OnlineStoreTheme, 'id' | 'name' | 'role' | 'updatedAt'>> }> };

export type CofounderListThemeFilesQueryVariables = AdminTypes.Exact<{
  themeId: AdminTypes.Scalars['ID']['input'];
  first: AdminTypes.Scalars['Int']['input'];
}>;


export type CofounderListThemeFilesQuery = { theme?: AdminTypes.Maybe<(
    Pick<AdminTypes.OnlineStoreTheme, 'id' | 'name' | 'role'>
    & { files?: AdminTypes.Maybe<{ nodes: Array<Pick<AdminTypes.OnlineStoreThemeFile, 'filename' | 'size' | 'contentType'>>, pageInfo: Pick<AdminTypes.PageInfo, 'hasNextPage'> }> }
  )> };

export type CofounderReadThemeFileQueryVariables = AdminTypes.Exact<{
  themeId: AdminTypes.Scalars['ID']['input'];
  filenames: Array<AdminTypes.Scalars['String']['input']> | AdminTypes.Scalars['String']['input'];
}>;


export type CofounderReadThemeFileQuery = { theme?: AdminTypes.Maybe<(
    Pick<AdminTypes.OnlineStoreTheme, 'id' | 'name' | 'role'>
    & { files?: AdminTypes.Maybe<{ nodes: Array<(
        Pick<AdminTypes.OnlineStoreThemeFile, 'filename' | 'contentType'>
        & { body: { __typename: 'OnlineStoreThemeFileBodyBase64' } | (
          { __typename: 'OnlineStoreThemeFileBodyText' }
          & Pick<AdminTypes.OnlineStoreThemeFileBodyText, 'content'>
        ) | (
          { __typename: 'OnlineStoreThemeFileBodyUrl' }
          & Pick<AdminTypes.OnlineStoreThemeFileBodyUrl, 'url'>
        ) }
      )> }> }
  )> };

export type CofounderUpsertThemeFileMutationVariables = AdminTypes.Exact<{
  themeId: AdminTypes.Scalars['ID']['input'];
  files: Array<AdminTypes.OnlineStoreThemeFilesUpsertFileInput> | AdminTypes.OnlineStoreThemeFilesUpsertFileInput;
}>;


export type CofounderUpsertThemeFileMutation = { themeFilesUpsert?: AdminTypes.Maybe<{ upsertedThemeFiles?: AdminTypes.Maybe<Array<Pick<AdminTypes.OnlineStoreThemeFileOperationResult, 'filename'>>>, userErrors: Array<Pick<AdminTypes.OnlineStoreThemeFilesUserErrors, 'field' | 'message'>> }> };

export type CofounderThemePublishMutationVariables = AdminTypes.Exact<{
  id: AdminTypes.Scalars['ID']['input'];
}>;


export type CofounderThemePublishMutation = { themePublish?: AdminTypes.Maybe<{ theme?: AdminTypes.Maybe<Pick<AdminTypes.OnlineStoreTheme, 'id' | 'name' | 'role'>>, userErrors: Array<Pick<AdminTypes.ThemePublishUserError, 'field' | 'message' | 'code'>> }> };

export type CofounderUpdateProductMutationVariables = AdminTypes.Exact<{
  product: AdminTypes.ProductUpdateInput;
}>;


export type CofounderUpdateProductMutation = { productUpdate?: AdminTypes.Maybe<{ product?: AdminTypes.Maybe<Pick<AdminTypes.Product, 'id' | 'title' | 'status' | 'descriptionHtml'>>, userErrors: Array<Pick<AdminTypes.UserError, 'field' | 'message'>> }> };

export type CofounderSetInventoryQuantityMutationVariables = AdminTypes.Exact<{
  input: AdminTypes.InventorySetQuantitiesInput;
}>;


export type CofounderSetInventoryQuantityMutation = { inventorySetQuantities?: AdminTypes.Maybe<{ inventoryAdjustmentGroup?: AdminTypes.Maybe<(
      Pick<AdminTypes.InventoryAdjustmentGroup, 'reason'>
      & { changes: Array<Pick<AdminTypes.InventoryChange, 'name' | 'delta'>> }
    )>, userErrors: Array<Pick<AdminTypes.InventorySetQuantitiesUserError, 'field' | 'message'>> }> };

export type CofounderCreateDiscountCodeMutationVariables = AdminTypes.Exact<{
  basicCodeDiscount: AdminTypes.DiscountCodeBasicInput;
}>;


export type CofounderCreateDiscountCodeMutation = { discountCodeBasicCreate?: AdminTypes.Maybe<{ codeDiscountNode?: AdminTypes.Maybe<(
      Pick<AdminTypes.DiscountCodeNode, 'id'>
      & { codeDiscount: (
        Pick<AdminTypes.DiscountCodeBasic, 'title' | 'status'>
        & { codes: { nodes: Array<Pick<AdminTypes.DiscountRedeemCode, 'code'>> } }
      ) }
    )>, userErrors: Array<Pick<AdminTypes.DiscountUserError, 'field' | 'message'>> }> };

export type CofounderCreateBxgyDiscountMutationVariables = AdminTypes.Exact<{
  bxgyCodeDiscount: AdminTypes.DiscountCodeBxgyInput;
}>;


export type CofounderCreateBxgyDiscountMutation = { discountCodeBxgyCreate?: AdminTypes.Maybe<{ codeDiscountNode?: AdminTypes.Maybe<(
      Pick<AdminTypes.DiscountCodeNode, 'id'>
      & { codeDiscount: (
        Pick<AdminTypes.DiscountCodeBxgy, 'title' | 'status'>
        & { codes: { nodes: Array<Pick<AdminTypes.DiscountRedeemCode, 'code'>> } }
      ) }
    )>, userErrors: Array<Pick<AdminTypes.DiscountUserError, 'field' | 'message'>> }> };

export type CofounderCreateFreeShippingDiscountMutationVariables = AdminTypes.Exact<{
  freeShippingCodeDiscount: AdminTypes.DiscountCodeFreeShippingInput;
}>;


export type CofounderCreateFreeShippingDiscountMutation = { discountCodeFreeShippingCreate?: AdminTypes.Maybe<{ codeDiscountNode?: AdminTypes.Maybe<(
      Pick<AdminTypes.DiscountCodeNode, 'id'>
      & { codeDiscount: (
        Pick<AdminTypes.DiscountCodeFreeShipping, 'title' | 'status'>
        & { codes: { nodes: Array<Pick<AdminTypes.DiscountRedeemCode, 'code'>> } }
      ) }
    )>, userErrors: Array<Pick<AdminTypes.DiscountUserError, 'field' | 'message'>> }> };

export type CofounderUpdateDiscountCodeMutationVariables = AdminTypes.Exact<{
  id: AdminTypes.Scalars['ID']['input'];
  basicCodeDiscount: AdminTypes.DiscountCodeBasicInput;
}>;


export type CofounderUpdateDiscountCodeMutation = { discountCodeBasicUpdate?: AdminTypes.Maybe<{ codeDiscountNode?: AdminTypes.Maybe<(
      Pick<AdminTypes.DiscountCodeNode, 'id'>
      & { codeDiscount: (
        Pick<AdminTypes.DiscountCodeBasic, 'title' | 'status'>
        & { codes: { nodes: Array<Pick<AdminTypes.DiscountRedeemCode, 'code'>> } }
      ) }
    )>, userErrors: Array<Pick<AdminTypes.DiscountUserError, 'field' | 'message'>> }> };

export type CofounderDeactivateDiscountCodeMutationVariables = AdminTypes.Exact<{
  id: AdminTypes.Scalars['ID']['input'];
}>;


export type CofounderDeactivateDiscountCodeMutation = { discountCodeDeactivate?: AdminTypes.Maybe<{ codeDiscountNode?: AdminTypes.Maybe<(
      Pick<AdminTypes.DiscountCodeNode, 'id'>
      & { codeDiscount: Pick<AdminTypes.DiscountCodeBasic, 'title' | 'status'> | Pick<AdminTypes.DiscountCodeBxgy, 'title' | 'status'> | Pick<AdminTypes.DiscountCodeFreeShipping, 'title' | 'status'> }
    )>, userErrors: Array<Pick<AdminTypes.DiscountUserError, 'field' | 'message'>> }> };

export type CofounderDeleteDiscountCodeMutationVariables = AdminTypes.Exact<{
  id: AdminTypes.Scalars['ID']['input'];
}>;


export type CofounderDeleteDiscountCodeMutation = { discountCodeDelete?: AdminTypes.Maybe<(
    Pick<AdminTypes.DiscountCodeDeletePayload, 'deletedCodeDiscountId'>
    & { userErrors: Array<Pick<AdminTypes.DiscountUserError, 'field' | 'message'>> }
  )> };

export type CofounderStagedUploadsCreateMutationVariables = AdminTypes.Exact<{
  input: Array<AdminTypes.StagedUploadInput> | AdminTypes.StagedUploadInput;
}>;


export type CofounderStagedUploadsCreateMutation = { stagedUploadsCreate?: AdminTypes.Maybe<{ stagedTargets?: AdminTypes.Maybe<Array<(
      Pick<AdminTypes.StagedMediaUploadTarget, 'url' | 'resourceUrl'>
      & { parameters: Array<Pick<AdminTypes.StagedUploadParameter, 'name' | 'value'>> }
    )>>, userErrors: Array<Pick<AdminTypes.UserError, 'field' | 'message'>> }> };

export type CofounderFileCreateMutationVariables = AdminTypes.Exact<{
  files: Array<AdminTypes.FileCreateInput> | AdminTypes.FileCreateInput;
}>;


export type CofounderFileCreateMutation = { fileCreate?: AdminTypes.Maybe<{ files?: AdminTypes.Maybe<Array<Pick<AdminTypes.ExternalVideo, 'id' | 'fileStatus' | 'alt'> | Pick<AdminTypes.GenericFile, 'id' | 'fileStatus' | 'alt'> | (
      Pick<AdminTypes.MediaImage, 'id' | 'fileStatus' | 'alt'>
      & { image?: AdminTypes.Maybe<Pick<AdminTypes.Image, 'width' | 'height' | 'url'>> }
    ) | Pick<AdminTypes.Model3d, 'id' | 'fileStatus' | 'alt'> | Pick<AdminTypes.Video, 'id' | 'fileStatus' | 'alt'>>>, userErrors: Array<Pick<AdminTypes.FilesUserError, 'field' | 'message'>> }> };

export type CofounderCreateProductMutationVariables = AdminTypes.Exact<{
  product: AdminTypes.ProductCreateInput;
}>;


export type CofounderCreateProductMutation = { productCreate?: AdminTypes.Maybe<{ product?: AdminTypes.Maybe<Pick<AdminTypes.Product, 'id' | 'title' | 'handle' | 'status'>>, userErrors: Array<Pick<AdminTypes.UserError, 'field' | 'message'>> }> };

export type CofounderDeleteProductMutationVariables = AdminTypes.Exact<{
  input: AdminTypes.ProductDeleteInput;
}>;


export type CofounderDeleteProductMutation = { productDelete?: AdminTypes.Maybe<(
    Pick<AdminTypes.ProductDeletePayload, 'deletedProductId'>
    & { userErrors: Array<Pick<AdminTypes.UserError, 'field' | 'message'>> }
  )> };

export type CofounderShopEmailQueryVariables = AdminTypes.Exact<{ [key: string]: never; }>;


export type CofounderShopEmailQuery = { shop: Pick<AdminTypes.Shop, 'email'> };

interface GeneratedQueryTypes {
  "#graphql\n    query cofounderShopId {\n      shop {\n        id\n      }\n    }": {return: CofounderShopIdQuery, variables: CofounderShopIdQueryVariables},
  "#graphql\n  query cofounderSearchProducts($query: String, $first: Int!) {\n    products(first: $first, query: $query) {\n      nodes {\n        id\n        title\n        handle\n        status\n        totalInventory\n        priceRangeV2 {\n          minVariantPrice { amount currencyCode }\n          maxVariantPrice { amount currencyCode }\n        }\n      }\n    }\n  }": {return: CofounderSearchProductsQuery, variables: CofounderSearchProductsQueryVariables},
  "#graphql\n  query cofounderGetProduct($id: ID!) {\n    product(id: $id) {\n      id\n      title\n      handle\n      status\n      descriptionHtml\n      vendor\n      tags\n      totalInventory\n      variants(first: 20) {\n        nodes {\n          id\n          title\n          price\n          sku\n          inventoryQuantity\n        }\n      }\n    }\n  }": {return: CofounderGetProductQuery, variables: CofounderGetProductQueryVariables},
  "#graphql\n  query cofounderGetInventoryLevels($id: ID!) {\n    product(id: $id) {\n      id\n      title\n      variants(first: 20) {\n        nodes {\n          id\n          title\n          sku\n          inventoryItem {\n            id\n            tracked\n            inventoryLevels(first: 10) {\n              nodes {\n                location { id name }\n                quantities(names: [\"available\"]) {\n                  name\n                  quantity\n                }\n              }\n            }\n          }\n        }\n      }\n    }\n  }": {return: CofounderGetInventoryLevelsQuery, variables: CofounderGetInventoryLevelsQueryVariables},
  "#graphql\n  query cofounderGetShippingSetup {\n    shop {\n      name\n      currencyCode\n      shipsToCountries\n    }\n    deliveryProfiles(first: 10) {\n      nodes {\n        id\n        name\n        default\n        profileLocationGroups {\n          locationGroup {\n            id\n          }\n          locationGroupZones(first: 15) {\n            nodes {\n              zone {\n                id\n                name\n                countries {\n                  name\n                  code {\n                    countryCode\n                    restOfWorld\n                  }\n                }\n              }\n              methodDefinitions(first: 10) {\n                nodes {\n                  id\n                  name\n                  active\n                  rateProvider {\n                    ... on DeliveryRateDefinition {\n                      id\n                      price {\n                        amount\n                        currencyCode\n                      }\n                    }\n                  }\n                }\n              }\n            }\n          }\n        }\n      }\n    }\n  }": {return: CofounderGetShippingSetupQuery, variables: CofounderGetShippingSetupQueryVariables},
  "#graphql\n  query cofounderShopCurrency {\n    shop {\n      currencyCode\n    }\n  }": {return: CofounderShopCurrencyQuery, variables: CofounderShopCurrencyQueryVariables},
  "#graphql\n  query cofounderListDiscounts {\n    discountNodes(first: 20) {\n      nodes {\n        id\n        discount {\n          __typename\n          ... on DiscountCodeBasic {\n            title\n            status\n            summary\n            codes(first: 1) { nodes { code } }\n          }\n          ... on DiscountAutomaticBasic {\n            title\n            status\n            summary\n          }\n        }\n      }\n    }\n  }": {return: CofounderListDiscountsQuery, variables: CofounderListDiscountsQueryVariables},
  "#graphql\n  query cofounderGetShopInfo {\n    shop {\n      name\n      email\n      contactEmail\n      myshopifyDomain\n      primaryDomain { url host }\n      currencyCode\n      ianaTimezone\n      weightUnit\n      plan { publicDisplayName partnerDevelopment shopifyPlus }\n      shopPolicies { type title url body }\n    }\n  }": {return: CofounderGetShopInfoQuery, variables: CofounderGetShopInfoQueryVariables},
  "#graphql\n  query cofounderGetShopPolicies {\n    shop {\n      shopPolicies { type body }\n    }\n  }": {return: CofounderGetShopPoliciesQuery, variables: CofounderGetShopPoliciesQueryVariables},
  "#graphql\n  query cofounderListCustomers($first: Int!, $query: String, $after: String) {\n    customers(first: $first, query: $query, after: $after, sortKey: CREATED_AT, reverse: true) {\n      nodes {\n        id\n        displayName\n        firstName\n        lastName\n        numberOfOrders\n        amountSpent { amount currencyCode }\n        createdAt\n        defaultEmailAddress { emailAddress }\n        defaultPhoneNumber { phoneNumber }\n        defaultAddress {\n          address1\n          address2\n          city\n          province\n          provinceCode\n          country\n          countryCodeV2\n          zip\n        }\n      }\n      pageInfo { hasNextPage endCursor }\n    }\n  }": {return: CofounderListCustomersQuery, variables: CofounderListCustomersQueryVariables},
  "#graphql\n  query cofounderShopifyQL($query: String!) {\n    shopifyqlQuery(query: $query) {\n      tableData {\n        columns {\n          name\n          dataType\n          displayName\n        }\n        rows\n      }\n      parseErrors\n    }\n  }": {return: CofounderShopifyQLQuery, variables: CofounderShopifyQLQueryVariables},
  "#graphql\n  query cofounderGetDiscount($id: ID!) {\n    discountNode(id: $id) {\n      id\n      discount {\n        __typename\n        ... on DiscountCodeBasic {\n          title\n          status\n          codes(first: 1) { nodes { code } }\n        }\n        ... on DiscountCodeBxgy {\n          title\n          status\n          codes(first: 1) { nodes { code } }\n        }\n        ... on DiscountCodeFreeShipping {\n          title\n          status\n          codes(first: 1) { nodes { code } }\n        }\n        ... on DiscountAutomaticBasic { title status }\n        ... on DiscountAutomaticBxgy { title status }\n      }\n    }\n  }": {return: CofounderGetDiscountQuery, variables: CofounderGetDiscountQueryVariables},
  "#graphql\n  query cofounderListThemes {\n    themes(first: 20) {\n      nodes {\n        id\n        name\n        role\n        updatedAt\n      }\n    }\n  }": {return: CofounderListThemesQuery, variables: CofounderListThemesQueryVariables},
  "#graphql\n  query cofounderListThemeFiles($themeId: ID!, $first: Int!) {\n    theme(id: $themeId) {\n      id\n      name\n      role\n      files(first: $first) {\n        nodes {\n          filename\n          size\n          contentType\n        }\n        pageInfo { hasNextPage }\n      }\n    }\n  }": {return: CofounderListThemeFilesQuery, variables: CofounderListThemeFilesQueryVariables},
  "#graphql\n  query cofounderReadThemeFile($themeId: ID!, $filenames: [String!]!) {\n    theme(id: $themeId) {\n      id\n      name\n      role\n      files(filenames: $filenames, first: 1) {\n        nodes {\n          filename\n          contentType\n          body {\n            __typename\n            ... on OnlineStoreThemeFileBodyText {\n              content\n            }\n            ... on OnlineStoreThemeFileBodyUrl {\n              url\n            }\n          }\n        }\n      }\n    }\n  }": {return: CofounderReadThemeFileQuery, variables: CofounderReadThemeFileQueryVariables},
  "#graphql\n        query cofounderShopEmail {\n          shop {\n            email\n          }\n        }": {return: CofounderShopEmailQuery, variables: CofounderShopEmailQueryVariables},
}

interface GeneratedMutationTypes {
  "#graphql\n  mutation cofounderDeliveryProfileUpdate($id: ID!, $profile: DeliveryProfileInput!) {\n    deliveryProfileUpdate(id: $id, profile: $profile) {\n      profile { id name }\n      userErrors { field message }\n    }\n  }": {return: CofounderDeliveryProfileUpdateMutation, variables: CofounderDeliveryProfileUpdateMutationVariables},
  "#graphql\n  mutation cofounderShopPolicyUpdate($shopPolicy: ShopPolicyInput!) {\n    shopPolicyUpdate(shopPolicy: $shopPolicy) {\n      shopPolicy { id type url }\n      userErrors { field message code }\n    }\n  }": {return: CofounderShopPolicyUpdateMutation, variables: CofounderShopPolicyUpdateMutationVariables},
  "#graphql\n  mutation cofounderUpsertThemeFile($themeId: ID!, $files: [OnlineStoreThemeFilesUpsertFileInput!]!) {\n    themeFilesUpsert(themeId: $themeId, files: $files) {\n      upsertedThemeFiles {\n        filename\n      }\n      userErrors {\n        field\n        message\n      }\n    }\n  }": {return: CofounderUpsertThemeFileMutation, variables: CofounderUpsertThemeFileMutationVariables},
  "#graphql\n  mutation cofounderThemePublish($id: ID!) {\n    themePublish(id: $id) {\n      theme { id name role }\n      userErrors { field message code }\n    }\n  }": {return: CofounderThemePublishMutation, variables: CofounderThemePublishMutationVariables},
  "#graphql\n  mutation cofounderUpdateProduct($product: ProductUpdateInput!) {\n    productUpdate(product: $product) {\n      product {\n        id\n        title\n        status\n        descriptionHtml\n      }\n      userErrors { field message }\n    }\n  }": {return: CofounderUpdateProductMutation, variables: CofounderUpdateProductMutationVariables},
  "#graphql\n  mutation cofounderSetInventoryQuantity($input: InventorySetQuantitiesInput!) {\n    inventorySetQuantities(input: $input) {\n      inventoryAdjustmentGroup {\n        reason\n        changes { name delta }\n      }\n      userErrors { field message }\n    }\n  }": {return: CofounderSetInventoryQuantityMutation, variables: CofounderSetInventoryQuantityMutationVariables},
  "#graphql\n  mutation cofounderCreateDiscountCode($basicCodeDiscount: DiscountCodeBasicInput!) {\n    discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {\n      codeDiscountNode {\n        id\n        codeDiscount {\n          ... on DiscountCodeBasic {\n            title\n            status\n            codes(first: 1) { nodes { code } }\n          }\n        }\n      }\n      userErrors { field message }\n    }\n  }": {return: CofounderCreateDiscountCodeMutation, variables: CofounderCreateDiscountCodeMutationVariables},
  "#graphql\n  mutation cofounderCreateBxgyDiscount($bxgyCodeDiscount: DiscountCodeBxgyInput!) {\n    discountCodeBxgyCreate(bxgyCodeDiscount: $bxgyCodeDiscount) {\n      codeDiscountNode {\n        id\n        codeDiscount {\n          ... on DiscountCodeBxgy {\n            title\n            status\n            codes(first: 1) { nodes { code } }\n          }\n        }\n      }\n      userErrors { field message }\n    }\n  }": {return: CofounderCreateBxgyDiscountMutation, variables: CofounderCreateBxgyDiscountMutationVariables},
  "#graphql\n  mutation cofounderCreateFreeShippingDiscount($freeShippingCodeDiscount: DiscountCodeFreeShippingInput!) {\n    discountCodeFreeShippingCreate(freeShippingCodeDiscount: $freeShippingCodeDiscount) {\n      codeDiscountNode {\n        id\n        codeDiscount {\n          ... on DiscountCodeFreeShipping {\n            title\n            status\n            codes(first: 1) { nodes { code } }\n          }\n        }\n      }\n      userErrors { field message }\n    }\n  }": {return: CofounderCreateFreeShippingDiscountMutation, variables: CofounderCreateFreeShippingDiscountMutationVariables},
  "#graphql\n  mutation cofounderUpdateDiscountCode($id: ID!, $basicCodeDiscount: DiscountCodeBasicInput!) {\n    discountCodeBasicUpdate(id: $id, basicCodeDiscount: $basicCodeDiscount) {\n      codeDiscountNode {\n        id\n        codeDiscount {\n          ... on DiscountCodeBasic {\n            title\n            status\n            codes(first: 1) { nodes { code } }\n          }\n        }\n      }\n      userErrors { field message }\n    }\n  }": {return: CofounderUpdateDiscountCodeMutation, variables: CofounderUpdateDiscountCodeMutationVariables},
  "#graphql\n  mutation cofounderDeactivateDiscountCode($id: ID!) {\n    discountCodeDeactivate(id: $id) {\n      codeDiscountNode {\n        id\n        codeDiscount {\n          ... on DiscountCodeBasic { title status }\n          ... on DiscountCodeBxgy { title status }\n          ... on DiscountCodeFreeShipping { title status }\n        }\n      }\n      userErrors { field message }\n    }\n  }": {return: CofounderDeactivateDiscountCodeMutation, variables: CofounderDeactivateDiscountCodeMutationVariables},
  "#graphql\n  mutation cofounderDeleteDiscountCode($id: ID!) {\n    discountCodeDelete(id: $id) {\n      deletedCodeDiscountId\n      userErrors { field message }\n    }\n  }": {return: CofounderDeleteDiscountCodeMutation, variables: CofounderDeleteDiscountCodeMutationVariables},
  "#graphql\n  mutation cofounderStagedUploadsCreate($input: [StagedUploadInput!]!) {\n    stagedUploadsCreate(input: $input) {\n      stagedTargets {\n        url\n        resourceUrl\n        parameters { name value }\n      }\n      userErrors { field message }\n    }\n  }": {return: CofounderStagedUploadsCreateMutation, variables: CofounderStagedUploadsCreateMutationVariables},
  "#graphql\n  mutation cofounderFileCreate($files: [FileCreateInput!]!) {\n    fileCreate(files: $files) {\n      files {\n        id\n        fileStatus\n        alt\n        ... on MediaImage {\n          image { width height url }\n        }\n      }\n      userErrors { field message }\n    }\n  }": {return: CofounderFileCreateMutation, variables: CofounderFileCreateMutationVariables},
  "#graphql\n  mutation cofounderCreateProduct($product: ProductCreateInput!) {\n    productCreate(product: $product) {\n      product {\n        id\n        title\n        handle\n        status\n      }\n      userErrors { field message }\n    }\n  }": {return: CofounderCreateProductMutation, variables: CofounderCreateProductMutationVariables},
  "#graphql\n  mutation cofounderDeleteProduct($input: ProductDeleteInput!) {\n    productDelete(input: $input) {\n      deletedProductId\n      userErrors { field message }\n    }\n  }": {return: CofounderDeleteProductMutation, variables: CofounderDeleteProductMutationVariables},
}
declare module '@shopify/admin-api-client' {
  type InputMaybe<T> = AdminTypes.InputMaybe<T>;
  interface AdminQueries extends GeneratedQueryTypes {}
  interface AdminMutations extends GeneratedMutationTypes {}
}
