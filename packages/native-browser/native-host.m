// Native Chrome host: no interpreter, Electron environment or remote debugging.
#import <Foundation/Foundation.h>
#include <sys/types.h>
#include <sys/sysctl.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/stat.h>
#include <libproc.h>
#include <mach-o/dyld.h>
#include <poll.h>
#include <signal.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#define FRAME_LIMIT (900*1024)
static NSString *diagnosticPath;
static void diagnostic(NSString *code){
 if(!diagnosticPath)return;NSDictionary *value=@{@"code":code,@"pid":@(getpid()),@"ppid":@(getppid()),@"at":@((long long)([[NSDate date] timeIntervalSince1970]*1000))};NSData *data=[NSJSONSerialization dataWithJSONObject:value options:0 error:NULL];NSString *temporary=[diagnosticPath stringByAppendingFormat:@".%d.tmp",getpid()];int fd=open(temporary.fileSystemRepresentation,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW,0600);if(fd>=0){(void)write(fd,data.bytes,data.length);close(fd);rename(temporary.fileSystemRepresentation,diagnosticPath.fileSystemRepresentation);}unlink(temporary.fileSystemRepresentation);
}
static int problem(NSString *code){diagnostic(code);fprintf(stderr,"agent-browser:%s\n",code.UTF8String);return 1;}
static NSString *chromeProfile(pid_t pid){
 for(int depth=0;depth<6&&pid>1;depth++){
  int mib[3]={CTL_KERN,KERN_PROCARGS2,pid};size_t size=1024*1024;char *buffer=calloc(1,size);if(!buffer)return nil;
  NSString *found=nil;if(sysctl(mib,3,buffer,&size,NULL,0)==0&&size>sizeof(int)){
   int count;memcpy(&count,buffer,sizeof(int));char *p=buffer+sizeof(int),*limit=buffer+size;size_t n=strnlen(p,(size_t)(limit-p));
   if(n<(size_t)(limit-p)){const char *exe=p;p+=n+1;while(p<limit&&!*p)p++;
    if(strstr(exe,"/Google Chrome.app/Contents/MacOS/Google Chrome")&&count>0&&count<512)for(int i=0;i<count&&p<limit;i++){
     n=strnlen(p,(size_t)(limit-p));if(n==(size_t)(limit-p))break;
     if(strncmp(p,"--user-data-dir=",16)==0&&p[16]=='/'&&n<PATH_MAX+16){found=[[NSString alloc]initWithBytes:p+16 length:n-16 encoding:NSUTF8StringEncoding];break;}p+=n+1;
    }
   }
  }free(buffer);if(found)return found;struct proc_bsdinfo info;if(proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&info,sizeof(info))!=sizeof(info))break;pid=info.pbi_ppid;
 }return nil;
}
static BOOL sendAll(int fd,const void *bytes,size_t length){const char *p=bytes;while(length){ssize_t count=write(fd,p,length);if(count<0&&errno==EINTR)continue;if(count<=0)return NO;p+=count;length-=(size_t)count;}return YES;}
static BOOL sendJSON(int fd,NSDictionary *value){NSData *data=[NSJSONSerialization dataWithJSONObject:value options:0 error:NULL];if(!data||data.length>FRAME_LIMIT)return NO;uint32_t length=(uint32_t)data.length;return sendAll(fd,&length,4)&&sendAll(fd,data.bytes,data.length);}
typedef struct{unsigned char *data;size_t count;size_t wanted;} Stream;
static int relayOne(int from,int to,Stream *stream){
 ssize_t n=read(from,stream->data+stream->count,stream->wanted-stream->count);if(n<0&&errno==EINTR)return 0;if(n<=0)return -1;stream->count+=(size_t)n;
 if(stream->count==4&&stream->wanted==4){uint32_t length;memcpy(&length,stream->data,4);if(!length||length>FRAME_LIMIT)return -2;stream->wanted=4+length;}
 if(stream->count==stream->wanted){if(!sendAll(to,stream->data,stream->count))return -1;stream->count=0;stream->wanted=4;}return 0;
}
int main(int argc,char **argv){@autoreleasepool{
 signal(SIGPIPE,SIG_IGN);uint32_t length=PATH_MAX;char executable[PATH_MAX];if(_NSGetExecutablePath(executable,&length)!=0)return 1;NSString *directory=[@(executable) stringByDeletingLastPathComponent];diagnosticPath=[directory stringByAppendingPathComponent:@"bridge-diagnostic.json"];diagnostic(@"host_started");
 if(argc<2||strlen(argv[1])>256)return problem(@"extension_origin");NSString *origin=@(argv[1]);NSString *configPath=[directory stringByAppendingPathComponent:@"host-config.json"];
 int config=open(configPath.fileSystemRepresentation,O_RDONLY|O_NOFOLLOW);struct stat info;if(config<0||fstat(config,&info)||!S_ISREG(info.st_mode)||info.st_nlink!=1||info.st_uid!=getuid()||(info.st_mode&0077)||info.st_size<1||info.st_size>32768){if(config>=0)close(config);return problem(@"configuration");}
 NSMutableData *data=[NSMutableData dataWithLength:(NSUInteger)info.st_size];size_t offset=0;while(offset<data.length){ssize_t n=read(config,(char*)data.mutableBytes+offset,data.length-offset);if(n<0&&errno==EINTR)continue;if(n<=0){close(config);return problem(@"configuration");}offset+=(size_t)n;}close(config);
 id parsed=[NSJSONSerialization JSONObjectWithData:data options:0 error:NULL];if(![parsed isKindOfClass:[NSDictionary class]])return problem(@"configuration");NSDictionary *cfg=parsed;
 for(NSString *key in @[@"profile",@"token",@"agentId",@"extensionId",@"socketPath"])if(![cfg[key] isKindOfClass:[NSString class]])return problem(@"configuration");
 if(![origin isEqualToString:[NSString stringWithFormat:@"chrome-extension://%@/",cfg[@"extensionId"]]])return problem(@"extension_origin");
 NSString *profile=chromeProfile(getppid());if(!profile)return problem(@"profile_verifier");if(![profile isEqualToString:cfg[@"profile"]]||![profile hasPrefix:@"/"])return problem(@"profile_mismatch");
 int socketFd=socket(AF_UNIX,SOCK_STREAM,0);if(socketFd<0)return problem(@"app_unreachable");struct sockaddr_un address={0};address.sun_family=AF_UNIX;const char *socketPath=[cfg[@"socketPath"] fileSystemRepresentation];if(strlen(socketPath)>=sizeof(address.sun_path)){close(socketFd);return problem(@"configuration");}strcpy(address.sun_path,socketPath);
 if(connect(socketFd,(struct sockaddr*)&address,sizeof(address))){close(socketFd);return problem(@"app_unreachable");}
 if(!sendJSON(socketFd,@{@"type":@"hello",@"agentId":cfg[@"agentId"],@"profile":cfg[@"profile"],@"token":cfg[@"token"],@"origin":origin})){close(socketFd);return problem(@"app_disconnected");}diagnostic(@"socket_connected");
 Stream input={calloc(1,FRAME_LIMIT+4),0,4},output={calloc(1,FRAME_LIMIT+4),0,4};if(!input.data||!output.data){close(socketFd);free(input.data);free(output.data);return problem(@"memory_limit");}
 struct pollfd watched[2]={{STDIN_FILENO,POLLIN,0},{socketFd,POLLIN,0}};NSString *result=@"app_disconnected";
 for(;;){int count=poll(watched,2,-1);if(count<0&&errno==EINTR)continue;if(count<0)break;BOOL done=NO;for(int i=0;i<2;i++){if(watched[i].revents&POLLIN){int status=relayOne(watched[i].fd,i?STDOUT_FILENO:socketFd,i?&output:&input);if(status){result=status==-2?@"invalid_frame":i?@"app_disconnected":@"extension_disconnected";done=YES;break;}}else if(watched[i].revents&(POLLHUP|POLLERR|POLLNVAL)){result=i?@"app_disconnected":@"extension_disconnected";done=YES;break;}}if(done)break;}
 free(input.data);free(output.data);close(socketFd);return problem(result);
}}
