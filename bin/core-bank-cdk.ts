import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from "aws-cdk-lib/aws-iam";
import * as eks from 'aws-cdk-lib/aws-eks';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as msk from 'aws-cdk-lib/aws-msk';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { KubectlV32Layer as KubectlLayer } from "@aws-cdk/lambda-layer-kubectl-v32"
//import * as serverlessrepo from 'aws-cdk-lib/aws-serverlessrepo';
//import * as kubectl from '@aws-cdk/lambda-layer-kubectl';

export class CoreBankInfraStack extends cdk.Stack {
    public readonly vpc: ec2.Vpc;
    public readonly kafkaCluster: msk.CfnCluster;
    public readonly eksCluster: eks.Cluster;
    public readonly secret: secretsmanager.Secret;
    public readonly ec2Instance: ec2.Instance;
    public readonly rdsClusters: rds.DatabaseCluster[] = [];

    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        // VPC
        this.vpc = new ec2.Vpc(this, 'CoreBankVPC', {
            ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
            maxAzs: 3,
            subnetConfiguration: [
                { name: 'core-bank-web-public', subnetType: ec2.SubnetType.PUBLIC },
                { name: 'core-bank-eks-msk-private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
                { name: 'core-bank-DB-private', subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
            ],
        });

        // VPC Endpoints
        this.vpc.addGatewayEndpoint('S3Endpoint', { service: ec2.GatewayVpcEndpointAwsService.S3 });
        this.vpc.addGatewayEndpoint('DynamoDBEndpoint', { service: ec2.GatewayVpcEndpointAwsService.DYNAMODB });

        // MSK Cluster
        this.kafkaCluster = new msk.CfnCluster(this, 'KafkaCluster', {
            clusterName: 'composable-bank-kafka-cluster-3',
            kafkaVersion: '3.6.0',
            numberOfBrokerNodes: 6,
            brokerNodeGroupInfo: {
                instanceType: 'kafka.m5.large',
                clientSubnets: this.vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds,
                storageInfo: { ebsStorageInfo: { volumeSize: 1000 } },
            },
            //encryptionInfo: { encryptionAtRest: { dataVolumeKmsKeyId: 'AWS_OWNED_KMS_KEY' } },
            //encryptionInfo: { encryptionAtRest: { dataVolumeKmsKeyId: 'alias/aws/kafka' } },
        });

        // EKS Cluster
        //const kubectlLayer = lambda.LayerVersion.fromLayerVersionArn(this, 'KubectlLayer', 'arn:aws:serverlessrepo:us-east-1:903779448426:applications/lambda-layer-kubectl');
        //     // Serverless Application Repository에서 Lambda Layer (kubectl) 추가
        // const kubectlLayerApp = new serverlessrepo.CfnApplication(this, 'KubectlLayerApp', {
        //     applicationId: 'arn:aws:serverlessrepo:us-east-1:903779448426:applications/lambda-layer-kubectl',
        // });

        // const kubectlLayer = lambda.LayerVersion.fromLayerVersionArn(this, 'KubectlLayer', `arn:aws:lambda:us-east-1:903779448426:layer:KubectlLayer:${kubectlLayerApp.attrLatestVersionVersion}`);
    

        // this.eksCluster = new eks.Cluster(this, 'EKSCluster', {
        //     version: eks.KubernetesVersion.V1_32,
        //     vpcSubnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
        //     defaultCapacity: 2,
        //     kubectlLayer: kubectlLayer,
        // });
        // EKS 클러스터 생성

        // this.eksCluster = new eks.Cluster(this, 'EKSCluster', {
        //   version: eks.KubernetesVersion.V1_32,
        //   vpc: this.vpc,
        //   vpcSubnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
        //   defaultCapacity: 2,
        //   //kubectlLayer: new kubectl.KubectlLayer(this, 'KubectlLayer'),
        // });

        // EKS 클러스터 생성
        const clusterLogging = [
            // eks.ClusterLoggingTypes.API,
            // eks.ClusterLoggingTypes.AUTHENTICATOR,
            // eks.ClusterLoggingTypes.SCHEDULER,
            eks.ClusterLoggingTypes.AUDIT,
            // eks.ClusterLoggingTypes.CONTROLLER_MANAGER,
          ];

        this.eksCluster = new eks.Cluster(this, 'CoreBankEKSCluster', {
            vpc: this.vpc,
            defaultCapacity: 0, // 기본 용량을 0으로 설정하여 관리형 노드 그룹을 수동으로 추가
            version: eks.KubernetesVersion.V1_32,
            kubectlLayer: new KubectlLayer(this, "kubectl"),
            ipFamily: eks.IpFamily.IP_V4,
            clusterLogging: clusterLogging,
        });
    
        this.eksCluster.addNodegroupCapacity("custom-node-group", {
            amiType: eks.NodegroupAmiType.AL2023_X86_64_STANDARD,
            instanceTypes: [new ec2.InstanceType('t3.medium')],
            desiredSize: 2,
            minSize: 2,
            maxSize: 5,
            diskSize: 20,
            nodeRole: new iam.Role(this, "eksClusterNodeGroupRole", {
              roleName: "eksClusterNodeGroupRole",
              assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
              managedPolicies: [
                "AmazonEKSWorkerNodePolicy",
                "AmazonEC2ContainerRegistryReadOnly",
                "AmazonEKS_CNI_Policy",
              ].map((policy) => iam.ManagedPolicy.fromAwsManagedPolicyName(policy)),
            }),
          });

        // Create RDS Security Group
        const rdsSecurityGroup = new ec2.SecurityGroup(this, 'RdsSecurityGroup', {
            vpc: this.vpc,
            allowAllOutbound: true,
        });

        // Allow EKS Pods to access RDS
        rdsSecurityGroup.addIngressRule(this.eksCluster.clusterSecurityGroup, ec2.Port.tcp(5432), 'Allow EKS to access RDS');

        // Shared Secret for RDS
        // this.secret = new secretsmanager.Secret(this, 'AuroraDBSharedSecret', {
        //     generateSecretString: {
        //         secretStringTemplate: JSON.stringify({ username: 'postgres' }),
        //         generateStringKey: 'password',
        //         excludePunctuation: false,
        //         passwordLength: 16,
        //     },
        // });

        // Aurora RDS Instances (5 DBs)
        const dbNames = ['modernbank-account', 'modernbank-user', 'modernbank-transfer', 'modernbank-customer', 'modernbank-cqrs'];
        
        dbNames.forEach((dbName, index) => {
            const dbSecret = new secretsmanager.Secret(this, `AuroraDBSecret-${dbName}`, {
                secretStringValue: cdk.SecretValue.unsafePlainText(JSON.stringify({
                    username: 'postgres',
                    password: 'postgres1234!',
                })),
            });

            const dbCluster = new rds.DatabaseCluster(this, `${dbName}`, { // 고유한 ID 사용
                engine: rds.DatabaseClusterEngine.auroraPostgres({ version: rds.AuroraPostgresEngineVersion.VER_14_13 }),
        
                // ✅ 각 클러스터에 대해 개별적으로 생성된 Secret을 사용
                credentials: rds.Credentials.fromSecret(dbSecret, 'postgres'),
        
                vpc: this.vpc, // ✅ VPC 지정
                vpcSubnets: { // ✅ 특정 서브넷 설정
                    subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
                },
        
                writer: rds.ClusterInstance.provisioned(`writer-${dbName}`, {
                    instanceType: ec2.InstanceType.of(ec2.InstanceClass.R7G, ec2.InstanceSize.LARGE),
                    // securityGroups: [rdsSecurityGroup], // ✅ 서브넷 설정은 제거 (지원되지 않음)
                }),
                readers: [
                    rds.ClusterInstance.provisioned(`reader-${dbName}`, {
                        instanceType: ec2.InstanceType.of(ec2.InstanceClass.R7G, ec2.InstanceSize.LARGE),
                        // securityGroups: [rdsSecurityGroup], // ✅ 서브넷 설정은 제거 (지원되지 않음)
                    }),
                ],
                clusterIdentifier: dbName,
            });
        
            this.rdsClusters.push(dbCluster);
        });



        // DynamoDB Tables
        new dynamodb.Table(this, 'CustomerTable', {
            tableName: 'customer',
            partitionKey: { name: 'customerId', type: dynamodb.AttributeType.STRING },
        });

        new dynamodb.Table(this, 'GenAITable', {
            tableName: 'genAIManagement',
            partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
        });

        new dynamodb.Table(this, 'ProductTable', {
            tableName: 'product',
            partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
        });


        // Public AMI를 사용하는 EC2 인스턴스 추가
        const publicSubnet = this.vpc.selectSubnets({ subnetType: ec2.SubnetType.PUBLIC }).subnets[0];

        // 보안 그룹 생성
        const securityGroup = new ec2.SecurityGroup(this, 'CoreBankEc2SecurityGroup', {
            vpc: this.vpc,
            allowAllOutbound: true, // 모든 아웃바운드 트래픽 허용
        });

        // SSH (22번 포트) 허용
        securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(22), 'Allow SSH access from anywhere');

        // RDS 접근 허용
        this.rdsClusters.forEach(cluster => {
            cluster.connections.allowDefaultPortFrom(securityGroup, 'Allow EC2 to connect to RDS');
        });
        // EC2 인스턴스 생성
        this.ec2Instance = new ec2.Instance(this, 'CoreBankEc2Instance', {
            vpc: this.vpc,
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.XLARGE),
            machineImage: ec2.MachineImage.genericLinux({
                'ap-northeast-2': 'ami-07c3eff95841e4cc4' // 공개된 AMI ID 입력
            }),
            securityGroup: securityGroup,
            vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC }
        });
    }
}

const app = new cdk.App();
new CoreBankInfraStack(app, 'CoreBankInfraStack',);
app.synth();