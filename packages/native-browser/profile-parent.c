// Trusted native-messaging host attestation: read the actual Chrome ancestor's
// NUL-delimited argv, never accept a profile path supplied by an extension page.
#include <sys/types.h>
#include <sys/sysctl.h>
#include <libproc.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>
int main(int argc,char **argv) {
  if(argc!=2)return 2; char *end=NULL; long raw=strtol(argv[1],&end,10); if(!end||*end||raw<2||raw>INT_MAX)return 2;
  pid_t pid=(pid_t)raw;
  for(int depth=0;depth<6&&pid>1;depth++) {
    int mib[3]={CTL_KERN,KERN_PROCARGS2,pid};size_t size=1024*1024; char *buffer=calloc(1,size);if(!buffer)return 3;
    if(sysctl(mib,3,buffer,&size,NULL,0)==0&&size>sizeof(int)){
      int count;memcpy(&count,buffer,sizeof(int)); char *p=buffer+sizeof(int),*limit=buffer+size;
      size_t n=strnlen(p,(size_t)(limit-p)); if(n==(size_t)(limit-p)){free(buffer);return 3;}
      const char *exe=p;p+=n+1;while(p<limit&&!*p)p++;
      if(strstr(exe,"/Google Chrome.app/Contents/MacOS/Google Chrome")&&count>0&&count<512){
        for(int i=0;i<count&&p<limit;i++){
          n=strnlen(p,(size_t)(limit-p));if(n==(size_t)(limit-p))break;
          if(strncmp(p,"--user-data-dir=",16)==0&&p[16]=='/'&&n<PATH_MAX+16){fwrite(p+16,1,n-16,stdout);free(buffer);return 0;}p+=n+1;
        }
      }
    }free(buffer);
    struct proc_bsdinfo info; if(proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&info,sizeof(info))!=sizeof(info))break;pid=info.pbi_ppid;
  }return 4;
}
