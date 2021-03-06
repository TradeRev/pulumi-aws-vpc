/*
 * Copyright 2018, James Nugent.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
 * If a copy of the MPL was not distributed with this file, You can obtain one at
 * http://mozilla.org/MPL/2.0/.
 */

import * as aws from "@pulumi/aws";
import { ComponentResource, Output, ResourceOptions } from "@pulumi/pulumi";
import { SubnetDistributor } from "./subnetDistributor";

export interface VpcInputs {
    description: string;
    baseTags: aws.Tags;

    baseCidr: string;
    azCount: number | "PerAZ";
    maxSubnets?: number;

    perAZ: number;

    createS3Endpoint?: boolean;
    createDynamoDbEndpoint?: boolean;
    enableFlowLogs?: boolean;

    zoneName?: string;
}

export interface VpcOutputs {
    vpcId: Output<string>;
    privateSubnetIds: Output<string>[];
    publicSubnetIds: Output<string>[];
    privateHostedZoneId: Output<string>;
}

export class Vpc extends ComponentResource implements VpcOutputs {
    public vpcId: Output<string>;
    public privateSubnetIds: Output<string>[];
    public publicSubnetIds: Output<string>[];
    public privateHostedZoneId: Output<string>;

    public static async create(name: string, inputs: VpcInputs, opts?: ResourceOptions) {
        const instance = new Vpc(name, opts);
        const instanceParent = {parent: instance};

        const baseName = name.toLowerCase();

        // VPC
        const vpcTags = Object.assign({
            Name: `${inputs.description} VPC`,
        }, inputs.baseTags);
        const vpc = new aws.ec2.Vpc(`${baseName}-vpc`, {
            cidrBlock: inputs.baseCidr,
            enableDnsSupport: true,
            enableDnsHostnames: true,
            tags: vpcTags,
        }, instanceParent);
        instance.vpcId = vpc.id;
        const vpcParent = {parent: vpc};

        // Private Hosted Zone
        if (inputs.zoneName) {
            const privateZone = new aws.route53.Zone(`${baseName}-private-hosted-zone`, {
                vpcs: [{
                    vpcId: vpc.id,
                }],
                name: inputs.zoneName,
                comment: `Private zone for ${inputs.zoneName}. Managed by Pulumi.`,
            }, vpcParent);
            instance.privateHostedZoneId = privateZone.id;

            const dhcpOptionSetTags = Object.assign({
                Name: `${inputs.description} DHCP Options`,
            }, inputs.baseTags);
            const dhcpOptionSet = new aws.ec2.VpcDhcpOptions(`${baseName}-dhcp-options`, {
                domainName: "",
                domainNameServers: ["AmazonProvidedDNS"],
                tags: dhcpOptionSetTags,
            }, vpcParent);
            const dhcpOptionSetParent = {parent: dhcpOptionSet};

            new aws.ec2.VpcDhcpOptionsAssociation(`${baseName}-dhcp-options-assoc`, {
                vpcId: vpc.id,
                dhcpOptionsId: dhcpOptionSet.id,
            }, dhcpOptionSetParent);
        }

        // Internet Gateway
        const internetGatewayTags = Object.assign({
            Name: `${inputs.description} VPC IG`,
        }, inputs.baseTags);
        const internetGateway = new aws.ec2.InternetGateway(`${baseName}-igw`, {
            vpcId: vpc.id,
            tags: internetGatewayTags,
        }, vpcParent);

        // Subnet Distributor
        let distributor: SubnetDistributor;
        const perAZ = inputs.perAZ || 1;
        if (typeof inputs.azCount === "number") {
            distributor = SubnetDistributor.fixedCount(inputs.baseCidr, inputs.azCount, perAZ);
        } else {
            distributor = await SubnetDistributor.perAz(inputs.baseCidr, perAZ);
        }

        const repeat = <T>(arr: T[], repeats: number) =>
            new Array<T>().concat(...new Array(repeats).fill(arr));

        // Find AZ names
        const azNames = repeat((await aws.getAvailabilityZones({
            state: "available",
        })).names, perAZ);

        // Public Subnets
        let azCounts: { [key: string]: number; } = {};
        const publicSubnets = (await distributor.publicSubnets()).slice(0, inputs.maxSubnets).map((cidr, index) => {
            const azName = azNames[index % azNames.length];
            const az = azName.charAt(azName.length - 1);
            const azIndex = azCounts[az] || 1;
            azCounts[az] = azIndex + 1;
            const subnetName = `${baseName}-public-${az}-${azIndex}`;
            const subnetTags = Object.assign({
                Name: subnetName,
            }, inputs.baseTags);
            return new aws.ec2.Subnet(subnetName, {
                vpcId: vpc.id,
                cidrBlock: cidr,
                mapPublicIpOnLaunch: true,
                availabilityZone: azName,
                tags: subnetTags,
            }, vpcParent);
        });
        instance.publicSubnetIds = publicSubnets.map(subnet => subnet.id);

        // Route Table for Public Subnets
        const defaultRouteTable = await vpc.defaultRouteTableId.apply(rtb => aws.ec2.getRouteTable({
            routeTableId: rtb,
        }));

        const publicRouteTableTags = Object.assign({
            Name: `${inputs.description} Public RT`,
        }, inputs.baseTags);

        const publicRouteTable = new aws.ec2.DefaultRouteTable(`${baseName}-public-rt`, {
            defaultRouteTableId: defaultRouteTable.apply(rt => rt.id),
            tags: publicRouteTableTags,
        }, vpcParent);
        const publicRouteTableParent = {parent: publicRouteTable};

        new aws.ec2.Route(`${baseName}-route-public-sn-to-ig`, {
            routeTableId: defaultRouteTable.apply(prt => prt.id),
            destinationCidrBlock: "0.0.0.0/0",
            gatewayId: internetGateway.id,
        }, publicRouteTableParent);

        // Associate public route table with each public subnet
        publicSubnets.map(async (subnet, index) => {
            const subnetParent = {parent: subnet};
            return new aws.ec2.RouteTableAssociation(`${baseName}-public-rta-${index + 1}`, {
                subnetId: subnet.id,
                routeTableId: publicRouteTable.id,
            }, subnetParent);
        });

        // Private Subnets
        azCounts = {};
        const privateSubnets = (await distributor.privateSubnets()).slice(0, inputs.maxSubnets).map((cidr, index) => {
            const azName = azNames[index % azNames.length];
            const az = azName.charAt(azName.length - 1);
            const azIndex = azCounts[az] || 1;
            azCounts[az] = azIndex + 1;
            const subnetName = `${baseName}-private-${az}-${azIndex}`;
            const subnetTags = Object.assign({
                Name: subnetName,
            }, inputs.baseTags);
            return new aws.ec2.Subnet(subnetName, {
                vpcId: vpc.id,
                cidrBlock: cidr,
                mapPublicIpOnLaunch: false,
                availabilityZone: azName,
                tags: subnetTags,
            }, vpcParent);
        });
        instance.privateSubnetIds = privateSubnets.map(subnet => subnet.id);

        // NAT Gateways for each private subnet
        const privateRouteTables = privateSubnets.map((subnet, index) => {
            const subnetParent = {parent: subnet};
            const privateRouteTableTags = Object.assign({
                Name: `${inputs.description} Private RT ${index + 1}`,
            }, inputs.baseTags);
            const privateRouteTable = new aws.ec2.RouteTable(`${baseName}-private-rt-${index + 1}`, {
                vpcId: vpc.id,
                tags: privateRouteTableTags,
            }, subnetParent);

            const eipTags = Object.assign({
                Name: `${inputs.description} NAT EIP ${index + 1}`,
            }, inputs.baseTags);

            // Elastic IP
            const eip = new aws.ec2.Eip(`${baseName}-nat-eip-${index + 1}`, {
                vpc: true,
                // TODO: this is a workaround for terraform error
                // tags: eipTags,
            }, subnetParent);

            // Create the NAT Gateway in the corresponding indexed PUBLIC subnet
            const natGatewayTags = Object.assign({
                Name: `${inputs.description} NAT GW ${index + 1}`,
            }, inputs.baseTags);
            const natGateway = new aws.ec2.NatGateway(`${baseName}-nat-gw-${index + 1}`, {
                allocationId: eip.id,
                subnetId: publicSubnets[index].id,
                tags: natGatewayTags,
            }, subnetParent);

            const privateRouteTableParent = {parent: privateRouteTable};
            new aws.ec2.Route(`${baseName}-route-private-sn-to-nat-${index + 1}`, {
                routeTableId: privateRouteTable.id,
                destinationCidrBlock: "0.0.0.0/0",
                gatewayId: natGateway.id,
            }, privateRouteTableParent);

            new aws.ec2.RouteTableAssociation(`${baseName}-private-rta-${index + 1}`, {
                subnetId: subnet.id,
                routeTableId: privateRouteTable.id,
            }, subnetParent);

            return privateRouteTable;
        });


        const allRouteTables = [vpc.defaultRouteTableId, ...privateRouteTables.map(rt => rt.id)];
        //
        if (inputs.createS3Endpoint) {
            new aws.ec2.VpcEndpoint(`${baseName}-s3-endpoint`, {
                vpcId: vpc.id,
                serviceName: `com.amazonaws.${aws.config.region}.s3`,
                routeTableIds: allRouteTables,
            }, vpcParent);
        }

        if (inputs.createDynamoDbEndpoint) {
            new aws.ec2.VpcEndpoint(`${baseName}-dynamodb-endpoint`, {
                vpcId: vpc.id,
                serviceName: `com.amazonaws.${aws.config.region}.dynamodb`,
                routeTableIds: allRouteTables,
            }, vpcParent);
        }

        if (inputs.enableFlowLogs) {
            const logGroupTags = Object.assign({
                Name: `${inputs.description} VPC Flow Logs`,
            }, inputs.baseTags);
            const logGroup = new aws.cloudwatch.LogGroup(`${baseName}-vpc-flow-logs`, {
                tags: logGroupTags,
            }, vpcParent);

            const flowLogsRole = new aws.iam.Role(`${baseName}-flow-logs-role`, {
                description: `${inputs.description} Flow Logs`,
                assumeRolePolicy: JSON.stringify(aws.iam.assumeRolePolicyForPrincipal({
                    Service: "vpc-flow-logs.amazonaws.com",
                })),
            }, vpcParent);
            const flowLogsRoleParent = {parent: flowLogsRole};

            const flowLogsPolicy: aws.iam.PolicyDocument = {
                Version: "2012-10-17",
                Statement: [
                    {
                        Effect: "Allow",
                        Resource: "*",
                        Action: [
                            "logs:CreateLogGroup",
                            "logs:CreateLogStream",
                            "logs:PutLogEvents",
                            "logs:DescribeLogGroups",
                            "logs:DescribeLogStreams",
                        ],
                    },
                ],
            };

            new aws.iam.RolePolicy(`${baseName}-flow-log-policy`, {
                name: "vpc-flow-logs",
                role: flowLogsRole.id,
                policy: flowLogsPolicy,
            }, flowLogsRoleParent);

            new aws.ec2.FlowLog(`${baseName}-flow-logs`, {
                logDestination: logGroup.arn,
                iamRoleArn: flowLogsRole.arn,
                vpcId: vpc.id,
                trafficType: "ALL",
            }, flowLogsRoleParent);
        }

        return instance;
    }

    private constructor(name: string, opts?: ResourceOptions) {
        super("operator-error:aws:Vpc", name, {}, opts);
    }
}
