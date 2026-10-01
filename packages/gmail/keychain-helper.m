#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#import <LocalAuthentication/LocalAuthentication.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#ifndef AW_GMAIL_SERVICE
#define AW_GMAIL_SERVICE "com.agent-workspaces.gmail"
#endif
#define LIMIT 32768
static void erase(void *data,size_t size){volatile unsigned char *p=data;while(size--)*p++=0;}
static CFMutableDictionaryRef query(const char *account){
 CFMutableDictionaryRef q=CFDictionaryCreateMutable(NULL,0,&kCFTypeDictionaryKeyCallBacks,&kCFTypeDictionaryValueCallBacks);
 CFDictionarySetValue(q,kSecClass,kSecClassGenericPassword);CFDictionarySetValue(q,kSecAttrService,CFSTR(AW_GMAIL_SERVICE));
 CFDictionarySetValue(q,kSecAttrAccount,!strcmp(account,"client")?CFSTR("desktop-client"):CFSTR("readonly-tokens"));
 CFDictionarySetValue(q,kSecAttrSynchronizable,kCFBooleanFalse);return q;
}
static int run(int argc,const char **argv){
 if(argc!=3|| (strcmp(argv[2],"client")&&strcmp(argv[2],"tokens")))return 1;
 CFMutableDictionaryRef q=query(argv[2]);OSStatus status;
 if(!strcmp(argv[1],"read")){
  CFDictionarySetValue(q,kSecReturnData,kCFBooleanTrue);CFDictionarySetValue(q,kSecMatchLimit,kSecMatchLimitOne);
  LAContext *context=[[LAContext alloc]init];context.interactionNotAllowed=YES;CFDictionarySetValue(q,kSecUseAuthenticationContext,(__bridge CFTypeRef)context);
  CFDataRef result=NULL;status=SecItemCopyMatching(q,(CFTypeRef *)&result);CFRelease(q);
  if(status==errSecItemNotFound)return 3;if(status!=errSecSuccess||!result)return 1;
  CFIndex size=CFDataGetLength(result);int ok=size>0&&size<=LIMIT&&fwrite(CFDataGetBytePtr(result),1,(size_t)size,stdout)==(size_t)size;CFRelease(result);return ok?0:1;
 }
 if(!strcmp(argv[1],"write")){
  if(isatty(STDIN_FILENO)){CFRelease(q);return 1;}unsigned char bytes[LIMIT+1];size_t size=fread(bytes,1,sizeof bytes,stdin);
  if(ferror(stdin)||!size||size>LIMIT||!feof(stdin)){erase(bytes,sizeof bytes);CFRelease(q);return 1;}
  CFDataRef value=CFDataCreate(NULL,bytes,(CFIndex)size);erase(bytes,sizeof bytes);
  CFMutableDictionaryRef update=CFDictionaryCreateMutable(NULL,0,&kCFTypeDictionaryKeyCallBacks,&kCFTypeDictionaryValueCallBacks);CFDictionarySetValue(update,kSecValueData,value);
  status=SecItemUpdate(q,update);if(status==errSecItemNotFound){CFDictionarySetValue(q,kSecValueData,value);status=SecItemAdd(q,NULL);}CFRelease(update);CFRelease(q);CFRelease(value);return status==errSecSuccess?0:1;
 }
 if(!strcmp(argv[1],"remove")){status=SecItemDelete(q);CFRelease(q);return status==errSecSuccess||status==errSecItemNotFound?0:1;}
 CFRelease(q);return 1;
}
int main(int argc,const char **argv){@autoreleasepool{return run(argc,argv);}}
