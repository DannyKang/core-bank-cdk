import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from "aws-cdk-lib/aws-iam";
import * as eks from 'aws-cdk-lib/aws-eks';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as msk from 'aws-cdk-lib/aws-msk';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cr from 'aws-cdk-lib/custom-resources'
import { KubectlV32Layer as KubectlLayer } from "@aws-cdk/lambda-layer-kubectl-v32"
import { VSCodeIde } from "@workshop-cdk-constructs/vscode-ide"
import { Identity } from 'aws-cdk-lib/aws-ses';
//import * as serverlessrepo from 'aws-cdk-lib/aws-serverlessrepo';
//import * as kubectl from '@aws-cdk/lambda-layer-kubectl';

export class CoreBankInfraStack extends cdk.Stack {
    public readonly vpc: ec2.Vpc;
    public readonly kafkaCluster: msk.CfnCluster;
    public readonly eksCluster: eks.Cluster;
    public readonly secret: secretsmanager.Secret;
    public readonly ec2Instance: ec2.Instance;
    public readonly rdsClusters: rds.DatabaseCluster[] = [];
    public readonly vscodeIde: VSCodeIde;

    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        const region = cdk.Stack.of(this).region;
        const account = cdk.Stack.of(this).account;

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
            clusterName: 'composable-bank-kafka-cluster',
            kafkaVersion: '3.6.0',
            numberOfBrokerNodes: 6,
            brokerNodeGroupInfo: {
                instanceType: 'kafka.m5.large',
                clientSubnets: this.vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds,
                storageInfo: { ebsStorageInfo: { volumeSize: 1000 } },
            },

        });


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
            vpcSubnets: [
                {
                    subnetGroupName: 'core-bank-eks-msk-private',
                }
            ],
            authenticationMode: cdk.aws_eks.AuthenticationMode.API_AND_CONFIG_MAP,
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
          }
        );

        // Create RDS Security Group
        const rdsSecurityGroup = new ec2.SecurityGroup(this, 'RdsSecurityGroup', {
            vpc: this.vpc,
            allowAllOutbound: true,
        });

        // Allow EKS Pods to access RDS
        rdsSecurityGroup.addIngressRule(this.eksCluster.clusterSecurityGroup, ec2.Port.tcp(5432), 'Allow EKS to access RDS');


        // Aurora RDS Instances (5 DBs)
        const dbNames = ['modernbank-account', 'modernbank-user', 'modernbank-transfer', 'modernbank-customer', 'modernbank-cqrs'];
        
        dbNames.forEach((dbName, index) => {
  
            const dbCluster = new rds.DatabaseCluster(this, `${dbName}`, { // 고유한 ID 사용
                engine: rds.DatabaseClusterEngine.auroraPostgres({ version: rds.AuroraPostgresEngineVersion.VER_14_13 }),
        
                // 클러스터에 username, password 사용
                //credentials: rds.Credentials.fromSecret(this.secret),
                credentials: rds.Credentials.fromUsername('postgres', {
                    password: cdk.SecretValue.unsafePlainText('postgres1234!'),
                }),
        
                vpc: this.vpc, 
                vpcSubnets: { 
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



        // // DynamoDB Tables
        // new dynamodb.Table(this, 'CustomerTable', {
        //     tableName: 'customer',
        //     partitionKey: { name: 'customerId', type: dynamodb.AttributeType.STRING },
        // });

        // new dynamodb.Table(this, 'GenAITable', {
        //     tableName: 'genAIManagement',
        //     partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
        // });

        // new dynamodb.Table(this, 'ProductTable', {
        //     tableName: 'product',
        //     partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
        // });

        // EKS cluster 생성 코드 다음에 추가

        // OIDC Provider를 위한 OpenID Connect Provider URL 가져오기, IRSA위한 구현
        // EKS 인증을 API 및 ConfigMap으로 설정했으므로 아래와 같이 생성을 걸면 충돌이 난다. 
        //Received response status [FAILED] from custom resource. Message returned: EntityAlreadyExistsException: Provider with url https://oidc.eks.a
        //p-northeast-2.amazonaws.com/id/BF0AE4A064249CB6A30CBEF3ED1B6921 already exists.
        //따라서 fromOpenIdConnectProviderArn을 사용하여 생성한다.
        // const openIdConnectProvider = new iam.OpenIdConnectProvider(this, 'CoreBankEksOIDCProvider', {
        //     url: this.eksCluster.clusterOpenIdConnectIssuerUrl,
        //     clientIds: ['sts.amazonaws.com'],
        // });
        
        // EKS 클러스터의 기존 OIDC provider 사용
        const openIdConnectProvider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
            this,
            'CoreBankEksOIDCProvider',
            `arn:aws:iam::${this.account}:oidc-provider/${this.eksCluster.clusterOpenIdConnectIssuerUrl.substring(8)}`
        );

        
        // Pod용 IAM Role 생성
        const podRole = new iam.Role(this, 'CoreBankPodRole', {
            roleName: 'modernbank-service-role',
            assumedBy: new iam.FederatedPrincipal(
            openIdConnectProvider.openIdConnectProviderArn,
            {
                StringLike: {
                [`${this.eksCluster.clusterOpenIdConnectIssuerUrl.substring(8)}:sub`]: "system:serviceaccount:modernbank:modernbank-*-sa"
                },
            },
            "sts:AssumeRoleWithWebIdentity"
            ),
        });
        
        // MSK 권한 정책
        const mskPolicy = new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['kafka:*'],
            resources: [`${this.kafkaCluster.attrArn}/*`],
        });
        
        // RDS 권한 정책
        const rdsPolicy = new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['rds:*'],
            resources: this.rdsClusters.map(cluster => 
            `arn:aws:rds:${region}:${account}:db:${cluster.clusterIdentifier}`
            ),
        });
        
        // DynamoDB 권한 정책
        const dynamodbPolicy = new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['dynamodb:*'],
            resources: [
            `arn:aws:dynamodb:${region}:${account}:table/product`,
            `arn:aws:dynamodb:${region}:${account}:table/customer`
            ],
        });
        
        // 정책들을 Role에 추가
        podRole.addToPolicy(mskPolicy);
        podRole.addToPolicy(rdsPolicy);
        podRole.addToPolicy(dynamodbPolicy);
        

        // OIDC Provider URL 검증을 위한 출력
        new cdk.CfnOutput(this, 'OIDCProviderUrl', {
            value: this.eksCluster.clusterOpenIdConnectIssuerUrl,
            description: 'OIDC Provider URL'
        });

        // OIDC Provider ARN 검증을 위한 출력
        new cdk.CfnOutput(this, 'OIDCProviderArn', {
            value: openIdConnectProvider.openIdConnectProviderArn,
            description: 'OIDC Provider ARN'
        });


        // Role ARN을 출력값으로 추가 (선택사항)
        new cdk.CfnOutput(this, 'PodRoleArn', {
            value: podRole.roleArn,
            description: 'ARN of IAM Role for EKS Pods'
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
        // SSH (8080번 포트) 허용 - VS Code
        securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(22), 'Allow 8080 access from anywhere');

        // RDS 접근 허용
        this.rdsClusters.forEach(cluster => {
            cluster.connections.allowDefaultPortFrom(securityGroup, 'Allow EC2 to connect to RDS');
        });

        // EC2 인스턴스를 위한 Role 생성
        const ec2Role = new iam.Role(this, 'CoreBankEc2Role', {
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
            // AdministratorAccess 관리형 정책 추가
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess')
            ]
        });

        // EC2 인스턴스 생성
        // this.ec2Instance = new ec2.Instance(this, 'CoreBankEc2Instance', {
        //     vpc: this.vpc,
        //     instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.XLARGE),
        //     machineImage: ec2.MachineImage.genericLinux({
        //         'ap-northeast-2': 'ami-08d803b9d3be267c0' // 공개된 AMI ID 입력
        //     }),
        //     securityGroup: securityGroup,
        //     vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
        //     role: ec2Role
        // });

        /////////////////////////////////
        // 추가 개발영역
        /////////////////////////////////

        //ALB 컨트롤러 설치. VPC태그 및 서브넷 태그 자동 추가.
        const albController = new eks.AlbController(this, 'CoreBankEKSAlbController', {
            cluster: this.eksCluster,
            version: eks.AlbControllerVersion.V2_8_2, // 원하는 버전 선택
          });

        // ECR 처리
        // CoreBankInfraStack 클래스 내부에 추가
        const repositoryNames = [
            'modernbank-account',
            'modernbank-b2bt',
            'modernbank-customer',
            'modernbank-cqrs',
            'modernbank-transfer',
            'modernbank-product',
            'modernbank-user'
        ];

        // ECR 리포지토리 생성
        const ecrRepositories = repositoryNames.map(repoName => 
            new ecr.Repository(this, `${repoName}Repository`, {
                repositoryName: repoName,
                // 선택적 설정
                removalPolicy: cdk.RemovalPolicy.DESTROY, // 스택 삭제 시 리포지토리도 삭제
                imageScanOnPush: true, // 이미지 푸시 시 취약점 스캔
                lifecycleRules: [
                    {
                        maxImageCount: 5, // 최대 이미지 수 제한
                        description: 'Keep only last 5 images'
                    }
                ]
            })
        );

        // (선택사항) 리포지토리 ARN을 출력값으로 추가
        repositoryNames.forEach((repoName, index) => {
            new cdk.CfnOutput(this, `${repoName}RepositoryArn`, {
                value: ecrRepositories[index].repositoryArn,
                description: `ARN of ${repoName} ECR Repository`
            });
            new cdk.CfnOutput(this, `${repoName}RepositoryUri`, {
                value: ecrRepositories[index].repositoryUri,
                description: `URI of ${repoName} ECR Repository`
            });
        });

        //vscode 인스턴스 개발중

        const ideRole = new iam.Role(this, 'CoreBankIdeRole', {
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess')
            ]
        });

        ideRole.addToPolicy(
            new iam.PolicyStatement({
                actions: ["ec2:*"],
                resources: ["*"],
            })
        )

        //vscode에 매핑되는 role이 eks의 access entry로 적용될 수 있도록 해야 
        //kubectl 이 승인됨
        const eksAccessEntry = new eks.AccessEntry(this, 'IdeEksAccessEntry', {
            cluster: this.eksCluster,
            principal: ideRole.roleArn,
            accessEntryType: eks.AccessEntryType.STANDARD,
            accessPolicies: [
                eks.AccessPolicy.fromAccessPolicyName(
                    'AmazonEKSClusterAdminPolicy',
                     {
                        accessScopeType: eks.AccessScopeType.CLUSTER,
                    }
                ),
            ]    
        });

        new cdk.CfnOutput(this, 'IdeEksAccessEntryArn', {
            value: eksAccessEntry.accessEntryArn,
            description: 'ARN of EKS Access Entry'
        });

        this.vscodeIde = new VSCodeIde(this, "CoreBankVSCodeIde", {
            vpc: this.vpc,
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.XLARGE),
            bootstrapTimeoutMinutes: 30,
            bootstrapScript: `
                curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
                chmod +x kubectl
                sudo mv kubectl /usr/local/bin
            `,
            // bootstrapScript: `
            //     curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
            //     chmod +x kubectl
            //     sudo mv kubectl /usr/local/bin

            //     sudo -u ec2-user bash -c "aws eks update-kubeconfig --name $(aws eks list-clusters --output json | jq -r '.clusters[0]')"
            //     sudo -u ec2-user bash -c "kubectl create namespace modernbank"
            //     sudo -u ec2-user bash -c "git clone https://github.com/sharplee7/modernbank-demo --branch V2.0-Add-Compensation --single-branch"
            //     sudo -u ec2-user bash -c "cd modernbank-demo; kubectl apply -f k8s/ingress.yaml"
            // `,
            extensions: [
                "AmazonWebServices.aws-toolkit-vscode",
                "ms-kubernetes-tools.vscode-kubernetes-tools",
                "redhat.vscode-yaml",
                "vscjava.vscode-spring-initializr",
                "vscjava.vscode-spring-boot-dashboard",
                "vscjava.vscode-java-dependency",
                "vscjava.vscode-gradle",
                "vmware.vscode-spring-boot",
                "vmware.vscode-boot-dev-pack",
                "redhat.java",
                "golang.go",
            ],
            role: ideRole,
            exportIdePassword: false,
        })

        // VSCode IDE에 의존성 추가
        // this.vscodeIde.node.addDependency(this.eksCluster);
        this.vscodeIde.node.addDependency(albController);

        const ideUrlOutput = new cdk.CfnOutput(this, "IdeUrl", { value: this.vscodeIde.accessUrl})
        const idePasswordOutput = new cdk.CfnOutput(this, "IdePassword", { value: this.vscodeIde.getIdePassword()})

        const vscodeSecurityGroup = this.vscodeIde.ec2Instance.connections.securityGroups[0];

        // EKS 클러스터의 보안 그룹에 인바운드 규칙 추가해야 kubectl 에 eks api를 호출할 수 있음.
        this.eksCluster.clusterSecurityGroup.addIngressRule(
            vscodeSecurityGroup,
            ec2.Port.allTraffic(),
            'Allow all traffic from VSCode IDE security group'
        );

        // (선택사항) 보안 그룹 ID를 출력값으로 추가 - 디버깅용
        new cdk.CfnOutput(this, 'VSCodeSecurityGroupId', {
            value: vscodeSecurityGroup.securityGroupId,
            description: 'Security Group ID of VSCode IDE'
        });

        ////////////////////////////////////////////////////////
        // 프론트엔드 EC2 생성
        ////////////////////////////////////////////////////////

//         // EC2 인스턴스 생성을 위한 사용자 데이터 스크립트를 준비하는 함수
//         const getFrontendUserdata = (ingressHostname: string) => {
//             const userData = ec2.UserData.forLinux();
//             userData.addCommands(`
// #!/bin/bash

// # Log 파일 설정
// LOGFILE="/var/log/modernbank-setup.log"
// exec > >(tee -a \${LOGFILE}) 2>&1

// # 시스템 업데이트
// echo "Updating system packages..."
// yum update -y

// # Git 설치
// echo "Installing Git..."
// yum install -y git

// # Node.js 20 설치
// echo "Installing Node.js 20..."
// curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
// yum install -y nodejs

// # Node.js 버전 확인
// echo "Node.js version:"
// node --version
// echo "npm version:"
// npm --version

// # 앱 디렉토리 생성
// GIT_DIR="/opt/modernbank-demo"
// APP_DIR="/opt/modenbank-demo/modernbank-ui"
// echo "Creating application directory: \${APP_DIR}"
// mkdir -p \${GIT_DIR}
// mkdir -p \${APP_DIR}

// # Git 리포지토리에서 코드 클론
// echo "Cloning the repository..."
// REPO_URL="https://github.com/sharplee7/modernbank-demo"
// BRANCH_NAME="V2.0-Add-Compensation"
// git clone \${REPO_URL} \${GIT_DIR} --branch \${BRANCH_NAME} --single-branch

// # 앱 디렉토리로 이동
// cd \${APP_DIR}

// # 의존성 패키지 설치
// echo "Installing dependencies..."
// npm ci

// # 환경 변수 파일 생성 (필요한 경우)
// echo "Creating .env.production file..."
// cat > .env.production << EOL
// # 공통 API 기본 URL
// NEXT_PUBLIC_API_BASE_URL="${ingressHostname}"

// # 서비스별 엔드포인트
// NEXT_PUBLIC_AUTH=\\\${NEXT_PUBLIC_API_BASE_URL}/user
// NEXT_PUBLIC_CUSTOMER=\\\${NEXT_PUBLIC_API_BASE_URL}/customer
// NEXT_PUBLIC_TRANSFER=\\\${NEXT_PUBLIC_API_BASE_URL}/transfer
// NEXT_PUBLIC_ACCOUNT=\\\${NEXT_PUBLIC_API_BASE_URL}/account
// NEXT_PUBLIC_CQRS=\\\${NEXT_PUBLIC_API_BASE_URL}/cqrs
// NEXT_PUBLIC_PRODUCT=\\\${NEXT_PUBLIC_API_BASE_URL}/product
// EOL

// # 앱 빌드
// echo "Building Next.js application..."
// npm run build

// # systemd 서비스 파일 생성
// echo "Creating systemd service..."
// cat > /etc/systemd/system/modernbank-ui.service << EOL
// [Unit]
// Description=ModernBank UI Next.js Application
// After=network.target

// [Service]
// Type=simple
// User=ec2-user
// WorkingDirectory=\${APP_DIR}
// ExecStart=/usr/bin/npm start
// Restart=on-failure
// Environment=NODE_ENV=production
// Environment=PORT=3000

// [Install]
// WantedBy=multi-user.target
// EOL

// # systemd 서비스 활성화 및 시작
// echo "Enabling and starting systemd service..."
// systemctl daemon-reload
// systemctl enable modernbank-ui.service
// systemctl start modernbank-ui.service

// # 서비스 상태 확인
// echo "Service status:"
// systemctl status modernbank-ui.service
//             `);
//             return userData;
//         }
        
//         // VSCode IDE에서 실행할 명령어를 통해 값을 얻어오는 커스텀 리소스
//         const getIngressHostname = new cr.AwsCustomResource(this, 'GetIngressHostname', {
//             onCreate: {
//               service: 'SSM',
//               action: 'sendCommand',
//               parameters: {
//                 InstanceIds: [this.vscodeIde.ec2Instance.instanceId],
//                 DocumentName: 'AWS-RunShellScript',
//                 Parameters: {
//                   commands: [
//                     'sudo -u ec2-user kubectl get ingress -n modernbank -o jsonpath=\'{.items[].status.loadBalancer.ingress[].hostname}\''
//                   ]
//                 }
//               },
//               physicalResourceId: cr.PhysicalResourceId.of('IngressHostnameCommand')
//             },
//             policy: cr.AwsCustomResourcePolicy.fromStatements([
//               new iam.PolicyStatement({
//                 actions: [
//                   'ssm:SendCommand',
//                   'ssm:GetCommandInvocation'
//                 ],
//                 resources: ['*']
//               })
//             ])
//         });

//         getIngressHostname.node.addDependency(this.vscodeIde);
//         getIngressHostname.node.addDependency(this.eksCluster);
//         getIngressHostname.node.addDependency(albController);
          
//         // 인그레스 호스트네임을 CloudFormation 출력으로 추가
//         new cdk.CfnOutput(this, 'IngressHostname', {
//             value: getIngressHostname.getResponseField('StandardOutputContent'),  // SSM SendCommand의 출력 경로
//             description: 'Ingress Hostname from kubectl command',
//             exportName: 'ModernBankIngressHostname'  // 다른 스택에서 참조할 수 있도록 export (선택사항)
//         });

        
//         // T3.small EC2 인스턴스 생성
//         const frontendEc2Instance = new ec2.Instance(this, 'FrontendEC2Instance', {
//             vpc: this.vpc,
//             instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
//             machineImage: ec2.MachineImage.latestAmazonLinux2(),
//             userData: getFrontendUserdata(getIngressHostname.getResponseField('StandardOutputContent')),
//             vpcSubnets: {
//                 subnetType: ec2.SubnetType.PUBLIC // 또는 필요에 따라 PRIVATE 선택
//             },
//             associatePublicIpAddress: true,
//             // 필요한 보안 그룹 설정
//             securityGroup: new ec2.SecurityGroup(this, 'FrontendEC2SecurityGroup', {
//                 vpc: this.vpc,
//                 allowAllOutbound: true,
//                 description: 'Security group for frontend EC2 instance'
//             })
//         });

//         //print frontendEc2Instance's public ip address
//         new cdk.CfnOutput(this, 'FrontendEC2InstancePublicIp', {
//             value: `frontendEc2Instance.instancePublicIp`,
//             description: 'Public IP of frontend EC2 instance'
//         });
//         new cdk.CfnOutput(this, 'FrontendEC2InstancePublicAddress', {
//             value: `http://${frontendEc2Instance.instancePublicIp}:3000`,
//             description: 'Public IP of frontend EC2 instance'
//         });
        
    }
}

const app = new cdk.App();
new CoreBankInfraStack(app, 'CoreBankInfraStack',);
app.synth();
